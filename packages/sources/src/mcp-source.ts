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
import { buildArgs, mapSearchArgs, usable, type ArgMapping, type ToolSchema } from "./schema-args";
import type { SearchQuery, Source } from "./source";

export interface McpSourceOptions {
  id: string;
  description: string;
  /** Builds the transport for this user's connection (stdio for local servers, streamable HTTP for remote ones). */
  transport: () => Transport;
  /**
   * The read tool to search with, and how a query becomes its arguments: an `args` function, or (without one) a
   * mapping read from the tool's input schema at connect (`schema-args.ts`), with `fixed` values the operator sets
   * (a collection, a channel) sent on every call.
   */
  searchTool: {
    name: string;
    args?: (query: SearchQuery) => Record<string, unknown>;
    fixed?: Record<string, unknown>;
  };
  /** Tools the server does not annotate read-only but an operator has verified are. */
  trustedReadTools?: string[];
}

export class ReadOnlyViolation extends Error {}

/** The search tool's schema could not be mapped to a call: no query argument, or a required one with no value. */
export class ArgumentMappingError extends Error {}

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
  private mapping: ArgMapping | null = null;

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
        if (!this.options.searchTool.args) {
          const m = mapSearchArgs(tool.inputSchema as ToolSchema, this.options.searchTool.fixed);
          if (!usable(m)) {
            const why = m.text ? `required arguments with no value: ${m.missing.join(", ")}` : "no query argument";
            throw new ArgumentMappingError(
              `${this.id}: cannot call ${tool.name}: ${why}; set searchTool.fixed or args`,
            );
          }
          this.mapping = m;
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
      {
        name: this.options.searchTool.name,
        arguments: this.options.searchTool.args
          ? this.options.searchTool.args(query)
          : buildArgs(this.mapping!, query.text, query.limit, Date.now()),
      },
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
 * text block that holds JSON (the whole block, or after one prose line ending in a colon, as in "Search results for
 * 'x':"); any other text block is one item. JSON that holds an empty result list is no items.
 *
 * An item's ref is the row's own id when it has one. Otherwise it is a hash of the row's identifying content (title
 * and full text, never scores or per-query excerpts), never its position: the partner's cache, ledger and dedup key
 * items by id, so a positional ref (the n-th row of every lookup) made different items from different lookups
 * overwrite each other (docs/research/connector-lab.md, finding 5).
 */
export function toItems(sourceId: string, content: unknown, limit: number, structured?: unknown): ContextItem[] {
  const out: ContextItem[] = [];
  const fromStructured = structured === undefined ? null : rowsOf(structured, 0);
  if (fromStructured) {
    for (const row of fromStructured) out.push(rowItem(sourceId, row));
    return out.slice(0, limit);
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  for (const block of blocks) {
    if (block.type !== "text" || !block.text) continue;
    const parsed = parseJson(block.text);
    if (parsed === undefined) {
      const ref = contentRef(block.text);
      out.push({ id: itemId(sourceId, ref), sourceId, ref, title: "", text: block.text });
      continue;
    }
    // JSON with no rows in it (`[]`, `{"totalFound": 0, "messages": []}`, `{}`) is an empty result.
    for (const row of rowsOf(parsed, 0) ?? []) out.push(rowItem(sourceId, row));
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

/** Fields that change from one query to the next for the same row: left out of a content-hash ref. */
const VOLATILE = /^(_.*|score|rank|distance|distances|relevance|similarity|highlights?|matches|snippet|excerpt|ex)$/i;

function rowItem(sourceId: string, row: Row): ContextItem {
  const ref = first(row, ID_KEYS) ?? contentRef(identity(row));
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

/**
 * What identifies a row with no id: every field except the volatile ones, so the same row returned by two queries
 * (another score, another excerpt) keeps one ref, while two rows that differ anywhere else (two contacts named Dana
 * Lee with different emails, two "Standup" events on different days) never share one.
 */
function identity(row: Row): string {
  const stable = Object.entries(row).filter(([k]) => !VOLATILE.test(k));
  // A row told apart only by a volatile field (a title and a snippet, nothing else) keeps that field: two such rows
  // must not share a ref, and a row with nothing stable has no better identity.
  const distinct = stable.some(([k]) => !TITLE_KEYS.includes(k));
  return JSON.stringify(Object.fromEntries(distinct ? stable : Object.entries(row)));
}

/**
 * A ref from content: stable across lookups for the same content, different for different content. The prefix marks
 * it as Eden's. The hash is of unredacted text, like the cache's own hashed refs; the cache redacts the item itself.
 */
function contentRef(text: string): string {
  return `eden-h-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/** One prose line ending in a colon before JSON, as servers that describe their result put it. */
const PROSE_THEN_JSON = /^[^\n]{1,200}:[ \t]*\r?\n\s*(?=[[{])/;

/** JSON in a text block: the whole block, or what follows one prose line ending in a colon. */
function parseJson(text: string): unknown {
  const trimmed = text.trimStart();
  const prose = PROSE_THEN_JSON.exec(trimmed);
  const body = prose ? trimmed.slice(prose[0].length) : trimmed;
  if (!/^[[{]/.test(body)) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const isObject = (x: unknown): x is Row => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * The result rows in a parsed value, `[]` for an empty result, or null when there are none to find:
 * - an array is the result list (its objects);
 * - Chroma's columnar `{ids: [[…]], documents: [[…]]}`;
 * - a container key (`results`, `hits`, `entities`…) holding a list decides, even when the list is empty: other lists
 *   and fields beside it (facets, filters, the echoed query URL or folder, a request id) are not results; then rows
 *   found inside a container key holding an object;
 * - an object with its own id, title or text is one record, nested lists included (an issue's labels, an event's
 *   attendees);
 * - with none of those, a sole list of objects among its values is the result list.
 */
function rowsOf(v: unknown, depth: number): Row[] | null {
  if (depth > 3 || !v || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.filter(isObject);
  const o = v as Row;
  const columnar = columns(o);
  if (columnar) return columnar;
  for (const k of CONTAINER_KEYS) if (Array.isArray(o[k])) return (o[k] as unknown[]).filter(isObject);
  // A wrapper object (`{data: {...}}`, `{result: {results: [...]}}`): what its container keys hold comes first, even
  // when the wrapper also echoes an id-like field (`{url, data: {results: [...]}}`).
  for (const k of CONTAINER_KEYS) {
    const rows = isObject(o[k]) ? rowsOf(o[k], depth + 1) : null;
    if (rows) return rows;
  }
  if (first(o, [...ID_KEYS, ...TITLE_KEYS, ...TEXT_KEYS])) return [o];
  const lists = Object.values(o).filter((x) => Array.isArray(x) && x.some(isObject));
  return lists.length === 1 ? (lists[0] as unknown[]).filter(isObject) : null;
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
