/**
 * Schema-driven arguments: how a lookup becomes a call to a search tool, read from the tool's own JSON schema rather
 * than written by hand per connector (docs/plans/query-planner.md). Real servers differ widely
 * (docs/research/connectors.md): the query may be `query`, `q`, `search_text` or an array (`query_texts`); some take
 * no free text at all, only fields (IMAP `subject`, `body`); some require context that is not text (a collection, a
 * channel, a date window).
 *
 * The mapping is deterministic: names first, then type, then description. The operator's `fixed` values always win
 * and fill anything the mapper cannot (a collection, a channel). A required argument with no value makes the
 * mapping unusable rather than guessed: a call that searches the wrong collection is worse than no call.
 */

export interface ToolSchema {
  type?: string;
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

interface PropertySchema {
  type?: string | string[];
  description?: string;
  items?: { type?: string };
  default?: unknown;
  enum?: unknown[];
  format?: string;
}

export interface ArgMapping {
  /** Where the query text goes, and whether that argument takes a list of queries. */
  text: { name: string; array: boolean } | null;
  /** The argument that bounds the result count, if any. */
  limit: string | null;
  /**
   * A date window (`start_date`/`end_date`, `startTime`/`endTime` and similar): filled with the request's own days
   * when it names some (D44), else, when the tool requires one, around now. `time` when the arguments take a
   * timestamp rather than a date.
   */
  window: { start: string; end: string; required: boolean; time: boolean; events: boolean } | null;
  /** Required arguments with no value: the mapping cannot be used until the operator fixes them. */
  missing: string[];
  /** Values the operator set, sent on every call. */
  fixed: Record<string, unknown>;
}

/** Names that take the query, best first. Field names (IMAP's body or subject) come last: they narrow, not search. */
const TEXT_NAMES = [
  "query",
  "q",
  "search",
  "search_query",
  "searchQuery",
  "search_text",
  "searchText",
  "search_term",
  "searchTerm",
  "query_text",
  "queryText",
  "query_texts",
  "queries",
  "text",
  "keywords",
  "keyword",
  "term",
  "terms",
  "pattern",
  "body",
  "subject",
  "content",
  "title",
];
/** Names that are the query whatever their description says (a query may document `tag:` syntax). */
const STRONG_TEXT = new Set(TEXT_NAMES.slice(0, TEXT_NAMES.indexOf("text") + 1));
const TAG_LIKE = /\b(flags?|labels?|tags?)\b/i;
const LIMIT_NAMES = [
  "limit",
  "max_results",
  "maxResults",
  "n_results",
  "num_results",
  "per_page",
  "perPage",
  "page_size",
  "pageSize",
  "top_k",
  "topK",
  "count",
  "size",
  "k",
];
/** Names that are never the query, whatever their type: ids, places to search, formats, sorting. */
const NOT_TEXT =
  /(^|_)(id|ids|uid|path|uri|url|date|time|since|before|after|collection|index|channel|folder|project|owner|repo|sort|order|format|mode|type|state|status|account|calendar|page|cursor|offset|lang|language|model)s?$/i;
const START_NAMES = /^(start|from|since|after|time_?min|date_?from)(_?(date|time))?$/i;
const END_NAMES = /^(end|to|until|before|time_?max|date_?to)(_?(date|time))?$/i;
/**
 * A window named as an event's range (`start`/`end`, `timeMin`/`timeMax`): a calendar's, which can list a day with no
 * words. `since`/`before` and the like filter mail by date, and a listing of them is the day's mail (D44).
 */
const EVENT_NAMES = /^(start|end|time_?min|time_?max)(_?(date|time))?$/i;

const typesOf = (p: PropertySchema) => (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []);

/** The argument mapping for a search tool, given its input schema and the operator's fixed values. */
export function mapSearchArgs(schema: ToolSchema, fixed: Record<string, unknown> = {}): ArgMapping {
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  const required = new Set(schema.required ?? []);

  let text: ArgMapping["text"] = null;
  const candidates = names.filter((n) => !(n in fixed) && !NOT_TEXT.test(n));
  const textual = (n: string) => {
    const t = typesOf(props[n]!);
    const isArray = t.includes("array") && (props[n]!.items?.type ?? "string") === "string";
    return { ok: t.length === 0 || t.includes("string") || isArray, array: isArray && !t.includes("string") };
  };
  for (const want of TEXT_NAMES) {
    const n = candidates.find((c) => c.toLowerCase() === want.toLowerCase());
    // A weak name described as flags, labels or tags filters by them (IMAP's custom `keywords`): not the query.
    const vetoed = n && !STRONG_TEXT.has(want) && TAG_LIKE.test(props[n]!.description ?? "");
    if (n && !vetoed && textual(n).ok && !props[n]!.enum) {
      text = { name: n, array: textual(n).array };
      break;
    }
  }
  if (!text) {
    // No known name: a string argument whose description says it is what to search for.
    const n = candidates.find(
      (c) => textual(c).ok && !props[c]!.enum && /\b(search|query|find|keywords?)\b/i.test(props[c]!.description ?? ""),
    );
    if (n) text = { name: n, array: textual(n).array };
  }

  const limit = LIMIT_NAMES.map((want) => names.find((n) => n === want)).find((n) => n && !(n in fixed)) ?? null;

  // A bare `from` or `to` is a sender or recipient on mail tools: a date only when the schema says it is one.
  const dateLike = (n: string) =>
    !/^(from|to)$/i.test(n) || /date|time/i.test(`${props[n]!.format ?? ""} ${props[n]!.description ?? ""}`);
  const start = names.find((n) => START_NAMES.test(n) && !(n in fixed) && dateLike(n));
  const end = names.find((n) => END_NAMES.test(n) && !(n in fixed) && dateLike(n));
  const isTime = (n: string) => /time/i.test(`${n} ${props[n]!.format ?? ""}`);
  const window =
    start && end
      ? {
          start,
          end,
          required: required.has(start) || required.has(end),
          time: isTime(start) || isTime(end),
          events: EVENT_NAMES.test(start) && EVENT_NAMES.test(end),
        }
      : null;

  const filled = new Set(
    [text?.name, limit, window?.required ? window.start : undefined, window?.required ? window.end : undefined]
      .concat(Object.keys(fixed))
      .filter(Boolean),
  );
  const missing = [...required].filter((n) => !filled.has(n) && props[n]?.default === undefined);
  return { text, limit, window, missing, fixed };
}

/** Whether calls can be made with this mapping. */
export const usable = (m: ArgMapping) => m.text !== null && m.missing.length === 0;

/** Days before and after now that a required date window covers: recent past and the weeks ahead. */
const WINDOW_DAYS: [number, number] = [30, 90];

/** The arguments for one call. `now` is the partner's clock (ms). */
export function buildArgs(
  m: ArgMapping,
  text: string,
  limit: number,
  now: number,
  window?: { start: string; end: string; offsetMinutes?: number },
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...m.fixed };
  if (m.text) args[m.text.name] = m.text.array ? [text] : text;
  if (m.limit) args[m.limit] = limit;
  if (m.window && (window || m.window.required)) {
    const day = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);
    // A timestamp argument takes the day's start at the user's offset (RFC 3339), "Z" when it is not known.
    const o = window?.offsetMinutes ?? 0;
    const zone = o === 0 ? "Z" : `${o < 0 ? "-" : "+"}${pad(Math.abs(o) / 60)}:${pad(Math.abs(o) % 60)}`;
    const at = (d: string) => (m.window!.time ? `${d}T00:00:00${zone}` : d);
    args[m.window.start] = at(window?.start ?? day(-WINDOW_DAYS[0]));
    args[m.window.end] = at(window?.end ?? day(WINDOW_DAYS[1]));
  }
  return args;
}

/** How a source ref becomes a call to a fetch (read-one) tool. */
export interface FetchMapping {
  /** The argument that takes the ref, and whether it takes a number (an issue number) rather than a string. */
  ref: { name: string; numeric: boolean } | null;
  /** Required arguments with no value: the mapping cannot be used until the operator fixes them. */
  missing: string[];
  fixed: Record<string, unknown>;
}

/** Names that take a record's id, best first. */
const REF_NAMES = [
  "id",
  "ref",
  "uid",
  "uuid",
  "key",
  "identifier",
  "uri",
  "url",
  "path",
  "file_path",
  "filePath",
  "permalink",
];
/**
 * A name that ends in an id (`message_id`, `pageId`, `documentID`): the ref when it is the only such argument. Never
 * a word that merely ends in "id" (`valid`, `paid`, `android`).
 */
const ID_LIKE = /(^|_)(id|ID)$|[a-z0-9](Id|ID)$/;
/** Names that take a search's text: never a fetch's ref, even as the one required argument. */
const SEARCH_TEXT = new Set(TEXT_NAMES.map((n) => n.toLowerCase()));

/**
 * The argument mapping for a fetch tool (one record by its id), given its input schema and the operator's fixed
 * values. The ref goes to a known id name, else to the one argument named like an id, else to the one required
 * string or number argument that is not a search's text; anything less certain is no mapping. Fetching the wrong
 * record is worse than none.
 */
export function mapFetchArgs(schema: ToolSchema, fixed: Record<string, unknown> = {}): FetchMapping {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const stringy = Object.keys(props).filter((n) => {
    const t = typesOf(props[n]!);
    const ok = t.length === 0 || t.includes("string") || t.includes("integer") || t.includes("number");
    return !(n in fixed) && !props[n]!.enum && ok;
  });
  const one = (names: string[]) => (names.length === 1 ? names[0]! : null);
  const name =
    REF_NAMES.map((want) => stringy.find((n) => n.toLowerCase() === want.toLowerCase())).find(Boolean) ??
    one(stringy.filter((n) => ID_LIKE.test(n))) ??
    one(stringy.filter((n) => required.has(n) && !SEARCH_TEXT.has(n.toLowerCase())));
  const filled = new Set([name, ...Object.keys(fixed)].filter(Boolean));
  const missing = [...required].filter((n) => !filled.has(n) && props[n]?.default === undefined);
  const numeric = name !== null && !typesOf(props[name]!).includes("string") && typesOf(props[name]!).length > 0;
  return { ref: name ? { name, numeric } : null, missing, fixed };
}

/** Whether fetch calls can be made with this mapping. */
export const fetchUsable = (m: FetchMapping) => m.ref !== null && m.missing.length === 0;

/** The arguments for one fetch call, or null when the ref cannot fill the argument (a non-numeric ref for a number). */
export function buildFetchArgs(m: FetchMapping, ref: string): Record<string, unknown> | null {
  if (!m.ref) return null;
  if (m.ref.numeric && !/^\d{1,15}$/.test(ref)) return null;
  return { ...m.fixed, [m.ref.name]: m.ref.numeric ? Number(ref) : ref };
}

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");

/** How a listing page becomes a call to a list tool (`McpSource.list`, D56). */
export interface ListMapping {
  /**
   * The argument that takes the page cursor: a server's own opaque token (`token`), or a count of items to skip
   * (`offset`), for which Eden computes the next page itself. Null when the tool cannot page: only its first page.
   */
  cursor: { name: string; kind: "token" | "offset" } | null;
  /** The argument that bounds the page size, if any. */
  limit: string | null;
  /** Required arguments with no value: the mapping cannot be used until the operator fixes them. */
  missing: string[];
  fixed: Record<string, unknown>;
}

/** Names that take a server's page token, best first. */
const CURSOR_NAMES = [
  "cursor",
  "pageToken",
  "page_token",
  "nextPageToken",
  "next_page_token",
  "continuation",
  "continuationToken",
  "starting_after",
  "after",
];
/** Names that take a count of items to skip. */
const OFFSET_NAMES = ["offset", "skip", "start_index", "startIndex"];

/**
 * The argument mapping for a list tool, given its input schema and the operator's fixed values: where the cursor
 * and the page size go. Nothing is guessed beyond known names: a list call needs no query, so a tool whose required
 * arguments the mapper cannot fill is unusable until the operator sets them (`fixed`).
 */
export function mapListArgs(schema: ToolSchema, fixed: Record<string, unknown> = {}): ListMapping {
  const props = schema.properties ?? {};
  const names = Object.keys(props).filter((n) => !(n in fixed));
  const required = new Set(schema.required ?? []);
  const find = (wanted: string[]) =>
    wanted.map((w) => names.find((n) => n.toLowerCase() === w.toLowerCase())).find(Boolean);
  const token = find(CURSOR_NAMES);
  const offset = token ? undefined : find(OFFSET_NAMES);
  const cursor: ListMapping["cursor"] = token
    ? { name: token, kind: "token" }
    : offset && typesOf(props[offset]!).some((t) => t === "integer" || t === "number")
      ? { name: offset, kind: "offset" }
      : null;
  const limit = LIMIT_NAMES.map((want) => names.find((n) => n === want)).find(Boolean) ?? null;
  // The cursor is not sent on a first page: a tool that requires one is one the mapper cannot start.
  const filled = new Set([limit, ...Object.keys(fixed)].filter(Boolean));
  const missing = [...required].filter((n) => !filled.has(n) && props[n]?.default === undefined);
  return { cursor, limit, missing, fixed };
}

/** Whether list calls can be made with this mapping. */
export const listUsable = (m: ListMapping) => m.missing.length === 0;

/** Longest cursor Eden keeps and hands back: a page token is short; anything longer is not taken as a cursor. */
export const MAX_CURSOR_CHARS = 2_048;

/** The arguments for one list call: the operator's values, the page size and, past the first page, the cursor. */
export function buildListArgs(m: ListMapping, cursor: string | undefined, limit: number): Record<string, unknown> {
  const args: Record<string, unknown> = { ...m.fixed };
  if (m.limit) args[m.limit] = limit;
  if (cursor !== undefined && m.cursor) args[m.cursor.name] = m.cursor.kind === "offset" ? Number(cursor) : cursor;
  return args;
}
