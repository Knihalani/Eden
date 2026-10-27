/**
 * A source backed by an MCP server's read tools: the way the partner reaches every connector the customer's agent
 * already has (mail, calendar, docs, CRM, a memory product). One instance per user and server.
 *
 * Read-only, as far as a client can check: the partner only ever calls the one configured search tool, and only if
 * the server declares it `readOnlyHint: true` or the operator lists it in `trustedReadTools` after checking it by
 * hand. The MCP spec says annotations are untrusted, so a server that lies passes this check: connect only servers
 * the operator trusts (D7). A failed connect is retried after RETRY_AFTER_MS, not on every lookup.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "./source";

export interface McpSourceOptions {
  id: string;
  description: string;
  /** Builds the transport for this user's connection (stdio for local servers, streamable HTTP for remote ones). */
  transport: () => Transport;
  /** The read tool to search with, and how a query becomes its arguments. */
  searchTool: { name: string; args: (query: SearchQuery) => Record<string, unknown> };
  /** Tools the server does not annotate read-only but an operator has verified are. */
  trustedReadTools?: string[];
}

export class ReadOnlyViolation extends Error {}

const RETRY_AFTER_MS = 30_000;

export class McpSource implements Source {
  readonly kind = "mcp";
  readonly id: string;
  readonly description: string;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** After a failed connect, no retry until this time: a broken server must not cost a reconnect per lookup. */
  private retryAt = 0;
  private lastError: unknown = null;

  constructor(private readonly options: McpSourceOptions) {
    this.id = options.id;
    this.description = options.description;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (Date.now() < this.retryAt) throw this.lastError;
    this.connecting ??= (async () => {
      const client = new Client({ name: "eden-partner", version: "0.0.0" });
      try {
        await client.connect(this.options.transport());
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === this.options.searchTool.name);
        if (!tool) throw new Error(`${this.id}: server has no tool ${this.options.searchTool.name}`);
        const trusted = this.options.trustedReadTools?.includes(tool.name) ?? false;
        if (tool.annotations?.readOnlyHint !== true && !trusted) {
          throw new ReadOnlyViolation(`${this.id}: ${tool.name} is not declared read-only and is not trusted`);
        }
        this.client = client;
        return client;
      } catch (e) {
        // Close on every failure, or a stdio server process leaks per attempt.
        await client.close().catch(() => {});
        this.lastError = e;
        this.retryAt = Date.now() + RETRY_AFTER_MS;
        throw e;
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]> {
    const client = await this.connect();
    const result = await client.callTool(
      { name: this.options.searchTool.name, arguments: this.options.searchTool.args(query) },
      undefined,
      { signal },
    );
    if (result.isError) return [];
    return toItems(this.id, result.content, query.limit);
  }

  async fetch(_ref: string, _scope: Scope): Promise<ContextItem | null> {
    return null; // TODO: per-server fetch tool mapping, for refreshing cached items.
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

type Block = { type: string; text?: string };

/**
 * Turns a tool result into items. A text block that parses as a JSON array (or `{results: [...]}`) yields one item
 * per element, reading the usual field names; any other text block is one item.
 */
export function toItems(sourceId: string, content: unknown, limit: number): ContextItem[] {
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  const out: ContextItem[] = [];
  blocks.forEach((block, b) => {
    if (block.type !== "text" || !block.text) return;
    const rows = jsonRows(block.text);
    if (!rows) {
      out.push({ id: itemId(sourceId, `block-${b}`), sourceId, ref: `block-${b}`, title: "", text: block.text });
      return;
    }
    rows.forEach((row, r) => {
      const ref = str(row.id) ?? str(row.ref) ?? str(row.url) ?? `block-${b}-${r}`;
      const text = str(row.text) ?? str(row.content) ?? str(row.body) ?? str(row.snippet) ?? JSON.stringify(row);
      out.push({
        id: itemId(sourceId, ref),
        sourceId,
        ref,
        title: str(row.title) ?? str(row.subject) ?? str(row.name) ?? "",
        text,
        url: str(row.url),
      });
    });
  });
  return out.slice(0, limit);
}

function jsonRows(text: string): Record<string, unknown>[] | null {
  try {
    const v: unknown = JSON.parse(text);
    const arr = Array.isArray(v) ? v : Array.isArray((v as { results?: unknown })?.results) ? (v as any).results : null;
    return arr ? arr.filter((x: unknown) => x && typeof x === "object") : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" ? `${v}` : undefined;
