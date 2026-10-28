/**
 * A source backed by an MCP server's read tools: the way the partner reaches every connector the customer's agent
 * already has (mail, calendar, docs, CRM, a memory product). One instance per user and server.
 *
 * Read-only, as far as a client can check: the partner only ever calls the one configured search tool, and only if
 * the server declares it `readOnlyHint: true` or the operator lists it in `trustedReadTools` after checking it by
 * hand. The MCP spec says annotations are untrusted, so a server that lies passes this check: connect only servers
 * the operator trusts (D7). A failed connect is retried after RETRY_AFTER_MS, not on every lookup.
 */
import { createHash } from "node:crypto";
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
    return toItems(this.id, result.content, query.limit, result.structuredContent);
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
type Row = Record<string, unknown>;

/**
 * Turns a tool result into items. Rows come from the result's `structuredContent` when it has them, else from each
 * text block that holds JSON (whole, or after a short prose line such as "Search results for 'x':"); any other text
 * block is one item.
 *
 * An item's ref is the row's own id when it has one. Otherwise it is a hash of the row's content, never its position:
 * the partner's cache, ledger and dedup key items by id, so a positional ref (the n-th row of every lookup) made
 * different items from different lookups overwrite each other (docs/research/connector-lab.md, finding 5).
 */
export function toItems(sourceId: string, content: unknown, limit: number, structured?: unknown): ContextItem[] {
  const out: ContextItem[] = [];
  const fromStructured = structured === undefined ? null : (rowsOf(structured, 0) ?? record(structured));
  if (fromStructured) {
    for (const row of fromStructured) out.push(rowItem(sourceId, row));
    return out.slice(0, limit);
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  for (const block of blocks) {
    if (block.type !== "text" || !block.text) continue;
    const parsed = parseJson(block.text);
    const rows = parsed === undefined ? null : (rowsOf(parsed, 0) ?? record(parsed));
    // JSON with no rows and no record in it (`[]`, `{"totalFound": 0, "messages": []}`) is an empty result.
    if (parsed !== undefined && !rows) continue;
    if (!rows) {
      const ref = contentRef(block.text);
      out.push({ id: itemId(sourceId, ref), sourceId, ref, title: "", text: block.text });
      continue;
    }
    for (const row of rows) out.push(rowItem(sourceId, row));
  }
  return out.slice(0, limit);
}

/** Fields that identify a row, most specific first. Not `name` or `title`: two contacts can share a name. */
const ID_KEYS = [
  "id",
  "ref",
  "uid",
  "uuid",
  "key",
  "_id",
  "permalink",
  "messageId",
  "message_id",
  "path",
  "file_path",
  "filePath",
  "uri",
  "url",
  "html_url",
  "link",
];
const TITLE_KEYS = ["title", "subject", "name", "summary", "filename"];
const TEXT_KEYS = ["text", "content", "body", "snippet", "excerpt", "description", "document", "observations"];
const URL_KEYS = ["url", "html_url", "link", "uri"];
/** Keys under which servers put their list of results, tried before any other array of objects. */
const CONTAINER_KEYS = [
  "results",
  "hits",
  "items",
  "data",
  "messages",
  "entities",
  "documents",
  "records",
  "issues",
  "notes",
  "events",
  "matches",
  "value",
  "result",
];

function rowItem(sourceId: string, row: Row): ContextItem {
  const ref = first(row, ID_KEYS) ?? contentRef(JSON.stringify(row));
  const url = URL_KEYS.map((k) => str(row[k])).find((u) => u && /^https?:\/\//.test(u));
  return {
    id: itemId(sourceId, ref),
    sourceId,
    ref,
    title: first(row, TITLE_KEYS) ?? "",
    text: first(row, TEXT_KEYS) ?? JSON.stringify(row),
    url,
  };
}

/** The first key of `keys` whose value is a non-empty string or number (or a list of strings, joined by lines). */
function first(row: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    const s = Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("\n") : str(v);
    if (s) return s;
  }
  return undefined;
}

/** A ref from content: stable across lookups for the same row, different for different rows. */
function contentRef(text: string): string {
  return `h-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/** JSON in a text block: the whole text, or what follows a short prose line before the first `{` or `[`. */
function parseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0 || start > 200) return undefined;
  try {
    return JSON.parse(start === 0 ? text : text.slice(start));
  } catch {
    return undefined;
  }
}

/**
 * The result rows in a parsed value: an array of objects; Chroma's columnar `{ids: [[…]], documents: [[…]]}`; or the
 * list under a container key (`results`, `hits`, `entities`…), looked for a few levels down.
 */
function rowsOf(v: unknown, depth: number): Row[] | null {
  if (depth > 3 || !v || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    const rows = v.filter((x): x is Row => !!x && typeof x === "object" && !Array.isArray(x));
    return rows.length ? rows : null;
  }
  const o = v as Row;
  const columnar = columns(o);
  if (columnar) return columnar;
  const keys = [...CONTAINER_KEYS.filter((k) => k in o), ...Object.keys(o).filter((k) => !CONTAINER_KEYS.includes(k))];
  for (const k of keys) {
    const rows = rowsOf(o[k], depth + 1);
    if (rows) return rows;
  }
  return null;
}

/** A single object that is itself a record (it has a title or text field), as one row. */
function record(v: unknown): Row[] | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Row;
  return [...TITLE_KEYS, ...TEXT_KEYS].some((k) => str(o[k])) ? [o] : null;
}

/** Chroma-style results: parallel lists, one per query (`ids: [[a, b]]`, `documents: [[da, db]]`). */
function columns(o: Row): Row[] | null {
  const ids = Array.isArray(o.ids) && Array.isArray(o.ids[0]) ? (o.ids[0] as unknown[]) : null;
  if (!ids || !ids.every((x) => typeof x === "string")) return null;
  const col = (k: string) =>
    Array.isArray(o[k]) && Array.isArray((o[k] as unknown[])[0]) ? (o[k] as unknown[][])[0]! : [];
  const docs = col("documents");
  const metas = col("metadatas");
  return ids.map((id, i) => ({ ...(metas[i] as Row | undefined), id, text: docs[i] }));
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" ? `${v}` : undefined;
