/**
 * A source backed by an MCP server's read tools: the way the partner reaches every connector the customer's agent
 * already has (mail, calendar, docs, CRM, a memory product). One instance per user and server.
 *
 * Read-only, as far as a client can check: the partner only ever calls the configured search tool and, when one is
 * configured, one fetch tool (read one record by its id), and each only if the server declares it
 * `readOnlyHint: true` or the operator lists it in `trustedReadTools` after checking it by hand (D7, D35). The MCP
 * spec says annotations are untrusted, so a server that lies passes this check: connect only servers the operator
 * trusts (D7). A failed connect is retried after RETRY_AFTER_MS, not on every lookup.
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import {
  buildArgs,
  buildFetchArgs,
  buildListArgs,
  fetchUsable,
  listUsable,
  mapFetchArgs,
  mapListArgs,
  mapSearchArgs,
  MAX_CURSOR_CHARS,
  usable,
  type ArgMapping,
  type FetchMapping,
  type ListMapping,
  type ToolSchema,
} from "./schema-args";
import type { ListPage, SearchQuery, Source } from "./source";

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
  /**
   * The read tool that returns one record by its id, for refreshing a cached item (`fetch`), if the server has one:
   * an `args` function, or a mapping read from its input schema, with `fixed` values as for search. Without it,
   * `fetch` returns null and cached items are refreshed only by searches that return them again.
   */
  fetchTool?: {
    name: string;
    args?: (ref: string) => Record<string, unknown>;
    fixed?: Record<string, unknown>;
  };
  /**
   * The read tool that lists the user's records most recently updated first, page by page, for a background sync
   * (`list`, D57), if the server has one: an `args` function, or a mapping read from its input schema (its cursor and
   * page-size arguments), with `fixed` values as for search. It passes the same read-only check as the search tool,
   * and one that fails it fails the connect. Without it, the source is not synced and is searched live.
   */
  listTool?: {
    name: string;
    args?: (cursor: string | undefined, limit: number) => Record<string, unknown>;
    fixed?: Record<string, unknown>;
  };
  /** Tools the server does not annotate read-only but an operator has verified are. */
  trustedReadTools?: string[];
  /** A connection that closes sooner than this after connecting delays the next connect (default 5 s). */
  quickCloseMs?: number;
}

export class ReadOnlyViolation extends Error {}

/** The search tool's schema could not be mapped to a call: no query argument, or a required one with no value. */
export class ArgumentMappingError extends Error {}

const RETRY_AFTER_MS = 30_000;
/** A connection that closes sooner than this after connecting waits `RETRY_AFTER_MS` before the next connect. */
const QUICK_CLOSE_MS = 5_000;
/** Pages of `tools/list` read at most: a server that keeps returning cursors cannot hold a connect forever. */
const MAX_TOOL_PAGES = 20;

/** Every tool the server lists, across `tools/list` pages. */
async function listAllTools(client: Client): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...res.tools);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

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
  private fetchMapping: FetchMapping | null = null;
  private listMapping: ListMapping | null = null;
  /** `list`, when a list tool is configured (D57); undefined otherwise, so the source is never synced. */
  readonly list?: Source["list"];

  constructor(private readonly options: McpSourceOptions) {
    this.id = options.id;
    this.description = options.description;
    if (options.listTool) this.list = (scope, cursor, limit, signal) => this.listPage(scope, cursor, limit, signal);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (Date.now() < this.retryAt) throw this.lastError;
    this.connecting ??= (async () => {
      const client = new Client({ name: "eden-partner", version: "0.0.0" });
      try {
        await client.connect(this.options.transport());
        const tools = await listAllTools(client);
        const tool = this.readTool(tools, this.options.searchTool.name);
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
        // A fetch tool is checked like the search tool, and a bad one fails the connect: an operator who configured
        // one expects refreshes, and a source that silently never refreshes would hide the mistake.
        const fetchTool = this.options.fetchTool;
        if (fetchTool) {
          const t = this.readTool(tools, fetchTool.name);
          if (!fetchTool.args) {
            const m = mapFetchArgs(t.inputSchema as ToolSchema, fetchTool.fixed);
            if (!fetchUsable(m)) {
              const why = m.ref ? `required arguments with no value: ${m.missing.join(", ")}` : "no id argument";
              throw new ArgumentMappingError(`${this.id}: cannot call ${t.name}: ${why}; set fetchTool.fixed or args`);
            }
            this.fetchMapping = m;
          }
        }
        // A list tool likewise: read-only or trusted, and mappable, or the connect fails and no tool is called.
        const listTool = this.options.listTool;
        if (listTool) {
          const t = this.readTool(tools, listTool.name);
          if (!listTool.args) {
            const m = mapListArgs(t.inputSchema as ToolSchema, listTool.fixed);
            if (!listUsable(m)) {
              throw new ArgumentMappingError(
                `${this.id}: cannot call ${t.name}: required arguments with no value: ${m.missing.join(", ")}; ` +
                  "set listTool.fixed or args",
              );
            }
            this.listMapping = m;
          }
        }
        // A dropped connection (a stdio server that exited, an expired HTTP session) clears the client, so the next
        // call connects again instead of failing with "Not connected" for the life of this source.
        const connectedAt = Date.now();
        client.onclose = () => {
          if (this.client !== client) return;
          this.client = null;
          // A server that dies right after connecting (crashing on every call) must not cost a process per lookup.
          if (Date.now() - connectedAt < (this.options.quickCloseMs ?? QUICK_CLOSE_MS)) {
            this.lastError = new Error(`${this.id}: connection closed ${Date.now() - connectedAt} ms after connecting`);
            this.retryAt = Date.now() + RETRY_AFTER_MS;
          }
        };
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

  /**
   * Lists by time when its search tool takes an event's range (`start`/`end`, `timeMin`/`timeMax`): a calendar. A mail
   * tool's `since`/`before` does not count (D44). Read at connect: false until then.
   */
  get listsByTime(): boolean {
    return this.mapping?.window?.events === true;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]> {
    const client = await this.connect();
    const result = await client.callTool(
      {
        name: this.options.searchTool.name,
        arguments: this.options.searchTool.args
          ? this.options.searchTool.args(query)
          : buildArgs(this.mapping!, query.text, query.limit, Date.now(), query.window),
      },
      undefined,
      { signal },
    );
    if (result.isError) return [];
    return toItems(this.id, result.content, query.limit, result.structuredContent);
  }

  /** The named tool, if the server has it and it is read-only (declared, or trusted by the operator). */
  private readTool(tools: Tool[], name: string): Tool {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${this.id}: server has no tool ${name}`);
    const trusted = this.options.trustedReadTools?.includes(tool.name) ?? false;
    if (tool.annotations?.readOnlyHint !== true && !trusted) {
      throw new ReadOnlyViolation(`${this.id}: ${tool.name} is not declared read-only and is not trusted`);
    }
    return tool;
  }

  /**
   * The current version of one item, by its ref, through the fetch tool; null when there is none, the server has no
   * such record, or the ref is Eden's own content hash (a row with no id of its own cannot be asked for again). Only
   * a returned row whose own id is the ref counts: prose ("No note found"), another record, or a row with no id is
   * null, never stored under the ref. The result is not redacted: whoever holds it runs it through the gate (D10).
   */
  async fetch(ref: string, _scope: Scope, signal?: AbortSignal): Promise<ContextItem | null> {
    const fetchTool = this.options.fetchTool;
    if (!fetchTool || ref.startsWith(CONTENT_REF)) return null;
    const client = await this.connect();
    const args = fetchTool.args ? fetchTool.args(ref) : buildFetchArgs(this.fetchMapping!, ref);
    if (!args) return null;
    const result = await client.callTool({ name: fetchTool.name, arguments: args }, undefined, { signal });
    if (result.isError) return null;
    const row = jsonRows(result.content, result.structuredContent).find((r) => first(r, ID_KEYS) === ref);
    return row ? rowItem(this.id, row) : null;
  }

  /**
   * One page of the user's records through the list tool, most recently updated first (D57), and the cursor of the
   * next. The next cursor is the server's (`nextCursor`, `nextPageToken`, Slack's `response_metadata.next_cursor`
   * and the like) or, for a tool that pages by offset, this one plus the rows returned while a page comes back full.
   * An error result throws, so a sync never reads a failed page as an empty listing (which would drop every item).
   * Items are not redacted here: whoever holds them runs them through the gate (D10).
   */
  private async listPage(_scope: Scope, cursor: string | undefined, limit: number, signal: AbortSignal) {
    const listTool = this.options.listTool!;
    const client = await this.connect();
    const args = listTool.args ? listTool.args(cursor, limit) : buildListArgs(this.listMapping!, cursor, limit);
    const result = await client.callTool({ name: listTool.name, arguments: args }, undefined, { signal });
    if (result.isError) throw new Error(`${this.id}: ${listTool.name} returned an error`);
    const items = toItems(this.id, result.content, limit, result.structuredContent);
    const page: ListPage = { items, next: null };
    if (!listTool.args && this.listMapping?.cursor?.kind === "offset") {
      const at = cursor === undefined ? 0 : Number(cursor);
      page.next = items.length >= limit && Number.isSafeInteger(at) ? String(at + items.length) : null;
    } else if (listTool.args || this.listMapping?.cursor) {
      page.next = nextCursorOf(result.content, result.structuredContent);
    }
    return page;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null; // first, so `onclose` sees a deliberate close and sets no reconnect backoff
    await client?.close();
  }
}

type Block = { type: string; text?: string };
type Row = Record<string, unknown>;

/** Keys under which servers put the next page's cursor, best first. */
const NEXT_KEYS = [
  "nextCursor",
  "next_cursor",
  "nextPageToken",
  "next_page_token",
  "nextToken",
  "next_token",
  "continuation",
  "continuationToken",
  "endCursor",
  "cursor",
];
/** Objects a cursor may sit in (`response_metadata` is Slack's, `pageInfo` GraphQL's). */
const CURSOR_HOLDERS = ["response_metadata", "pagination", "paging", "meta", "page_info", "pageInfo"];

/**
 * The next page's cursor in a list tool's result, or null when there is none (the last page). Read from the
 * structured content, else from the first text block that holds a JSON object: a known key at the top level or in
 * one known holder object, a non-empty string of at most `MAX_CURSOR_CHARS` (or a finite number). A result that says
 * `has_more: false` (`hasMore`, GraphQL's `hasNextPage`) has no next page whatever cursor it echoes. A fixed number of
 * key lookups: the rows are never scanned.
 */
export function nextCursorOf(content: unknown, structured?: unknown): string | null {
  let o: unknown = structured;
  if (!isObject(o)) {
    const blocks = Array.isArray(content) ? (content as Block[]) : [];
    const block = blocks.find((b) => b.type === "text" && typeof b.text === "string" && b.text.trimStart()[0] === "{");
    o = block ? parseJson(block.text!) : undefined;
  }
  if (!isObject(o)) return null;
  const pick = (x: Row): string | null => {
    if (x.has_more === false || x.hasMore === false || x.hasNextPage === false) return null;
    for (const k of NEXT_KEYS) {
      const v = x[k];
      if (typeof v === "string" && v.length > 0 && v.length <= MAX_CURSOR_CHARS) return v;
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return null;
  };
  if (o.has_more === false || o.hasMore === false) return null;
  const top = pick(o);
  if (top !== null) return top;
  for (const h of CURSOR_HOLDERS) {
    const holder = o[h];
    if (!isObject(holder)) continue;
    if (holder.has_more === false || holder.hasMore === false || holder.hasNextPage === false) return null;
    const got = pick(holder);
    if (got !== null) return got;
  }
  return null;
}

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

/** The rows of a tool result: its `structuredContent`, else every text block that holds JSON. Prose is no row. */
function jsonRows(content: unknown, structured?: unknown): Row[] {
  const fromStructured = structured === undefined ? null : rowsOf(structured, 0);
  if (fromStructured) return fromStructured;
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  return blocks.flatMap((b) => {
    const parsed = b.type === "text" && b.text ? parseJson(b.text) : undefined;
    return parsed === undefined ? [] : (rowsOf(parsed, 0) ?? []);
  });
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
  const meta = structureOf(row);
  return {
    id: itemId(sourceId, ref),
    sourceId,
    ref,
    title: first(row, TITLE_KEYS) ?? "",
    text: first(row, TEXT_KEYS) ?? JSON.stringify(row),
    url,
    ...(meta ? { meta } : {}),
  };
}

/** Fields naming who takes part in a row: attendees, sender, recipients, owners. */
const PEOPLE_KEYS = [
  "attendees",
  "participants",
  "organizer",
  "creator",
  "from",
  "sender",
  "to",
  "toRecipients",
  "cc",
  "ccRecipients",
  "author",
  "assignee",
  "owner",
  "members",
];
/** Fields holding when a row starts (an event), as an ISO string or Google Calendar's `{ dateTime | date }`. */
const START_KEYS = ["start", "startTime", "start_time", "startDate", "dtstart", "begin"];

/**
 * Who takes part in a row and when it starts, kept as structure (D44): `meta.people` as "Display Name <email>"
 * entries joined by "; " (the user's own entry, `self: true`, left out), `meta.start` as the server's own timestamp,
 * offset kept. Undefined when the row has neither.
 */
export function structureOf(row: Row): Record<string, string> | undefined {
  const people: string[] = [];
  const person = (v: unknown): void => {
    if (people.length >= 30) return;
    if (typeof v === "string" && v.trim()) people.push(v.trim().slice(0, 200));
    else if (Array.isArray(v)) v.forEach(person);
    else if (v && typeof v === "object" && !(v as Row).self) {
      const p = v as Row;
      const name = str(p.displayName) ?? str(p.name) ?? "";
      const email = str(p.email) ?? str(p.address) ?? "";
      const entry = email ? (name ? `${name} <${email}>` : email) : name;
      if (entry) people.push(entry.slice(0, 200));
    }
  };
  for (const k of PEOPLE_KEYS) person(row[k]);
  let start: string | undefined;
  for (const k of START_KEYS) {
    const v = row[k];
    const s = v && typeof v === "object" ? (str((v as Row).dateTime) ?? str((v as Row).date)) : str(v);
    if (s && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) {
      start = s;
      break;
    }
  }
  if (people.length === 0 && !start) return undefined;
  return { ...(people.length ? { people: people.join("; ") } : {}), ...(start ? { start } : {}) };
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
  return `${CONTENT_REF}${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/** Marks a ref as Eden's content hash rather than the server's own id. */
const CONTENT_REF = "eden-h-";

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
