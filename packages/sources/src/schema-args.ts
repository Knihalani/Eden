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
  /** A required date window (`start_date`/`end_date` and similar), filled around now. */
  window: { start: string; end: string } | null;
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

  const start = names.find((n) => START_NAMES.test(n) && !(n in fixed));
  const end = names.find((n) => END_NAMES.test(n) && !(n in fixed));
  const window = start && end && (required.has(start) || required.has(end)) ? { start, end } : null;

  const filled = new Set([text?.name, limit, window?.start, window?.end, ...Object.keys(fixed)].filter(Boolean));
  const missing = [...required].filter((n) => !filled.has(n) && props[n]?.default === undefined);
  return { text, limit, window, missing, fixed };
}

/** Whether calls can be made with this mapping. */
export const usable = (m: ArgMapping) => m.text !== null && m.missing.length === 0;

/** Days before and after now that a required date window covers: recent past and the weeks ahead. */
const WINDOW_DAYS: [number, number] = [30, 90];

/** The arguments for one call. `now` is the partner's clock (ms). */
export function buildArgs(m: ArgMapping, text: string, limit: number, now: number): Record<string, unknown> {
  const args: Record<string, unknown> = { ...m.fixed };
  if (m.text) args[m.text.name] = m.text.array ? [text] : text;
  if (m.limit) args[m.limit] = limit;
  if (m.window) {
    const day = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);
    args[m.window.start] = day(-WINDOW_DAYS[0]);
    args[m.window.end] = day(WINDOW_DAYS[1]);
  }
  return args;
}
