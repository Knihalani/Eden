/**
 * Query shapes: the ways a lookup can phrase one cue for a connector (docs/plans/query-planner.md). The connector lab
 * measured that no shape wins everywhere: the cue's terms reach nothing on a connector that matches the whole query
 * as one substring, where one call per entity reaches most cases; on OR and vector search the terms do best
 * (docs/research/connector-lab.md). The planner learns which to use per connector; this module only builds them.
 *
 * Every query is built from untrusted text (the user's and the agent's words, item text), so a shape never passes
 * syntax through: characters and words that are operators in common search syntaxes (Gmail, Lucene, FTS5, Bleve,
 * JQL, IMAP) are dropped, and the only operator a shape ever emits is a pair of double quotes, and only for a
 * connector the operator or a probe has said supports them.
 */

export type Shape = "terms" | "entities" | "each-entity" | "entity+term" | "phrase";

export const SHAPES: readonly Shape[] = ["terms", "entities", "each-entity", "entity+term", "phrase"];

export interface ShapeInput {
  /** The cue's content terms, space-separated (`SearchQuery.text`). */
  text: string;
  /** Entities the cue named (`SearchQuery.entities`). */
  entities: string[];
}

export interface ShapeOptions {
  /** The connector treats `"a b"` as a phrase. Unknown means no: a quote is then dropped like any operator. */
  quotes: boolean;
  /** How common a term is in the user's own items (higher = more common); the rarest term is the most specific. */
  frequency?: (term: string) => number;
  /** At most this many calls for shapes that make one per entity. */
  maxCalls?: number;
}

/** Longest query string a shape sends: long enough for any cue, short enough that no server chokes on it. */
const MAX_QUERY = 256;
/** Operator words in common search syntaxes; upper case only, as every one of them treats lower case as a word. */
const OPERATOR_WORDS = new Set(["AND", "OR", "NOT", "NEAR", "TO"]);

/**
 * Text with every search-syntax character turned into a space: quotes, field and range separators, grouping, wildcards,
 * fuzziness and boosting marks, escapes, boolean symbols, SQL LIKE's `%`, and a leading `-` or `+` on any word
 * (negation and requirement). Hyphens and dots inside words stay (`OPS-142`, `dana.lee@acme.com`), as do `@` and `#`.
 * So does `_`: it is LIKE's one-character wildcard, but also part of identifiers (`snake_case`, handles), and on a
 * LIKE connector it can only widen a read-only match by one character.
 */
export function inert(text: string): string {
  const words = text
    .replace(/["'`‘’“”:()[\]{}<>*?~^\\|&!=;,/%]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-+.]+/, "").replace(/[-+.]+$/, ""))
    .filter((w) => w && !OPERATOR_WORDS.has(w));
  return truncateWords(words.join(" "), MAX_QUERY);
}

function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > 0 ? cut.slice(0, space) : cut;
}

/** Entities as they will be sent: made inert, deduplicated case-insensitively, empty ones dropped. */
function cleanEntities(entities: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entities) {
    const c = inert(e);
    const key = c.toLowerCase();
    if (!c || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Whether a shape can be built for this input (entity shapes need an entity; phrase needs quote support). */
export function applies(shape: Shape, input: ShapeInput, options: ShapeOptions): boolean {
  return buildShape(shape, input, options).length > 0;
}

/**
 * The query strings a shape sends for one cue, in order (several only for `each-entity`), or none when the shape
 * does not apply. Every string is inert except for the phrase quotes `phrase` adds.
 */
export function buildShape(shape: Shape, input: ShapeInput, options: ShapeOptions): string[] {
  const terms = inert(input.text);
  const entities = cleanEntities(input.entities);
  const maxCalls = Math.max(1, options.maxCalls ?? 3);
  switch (shape) {
    case "terms":
      return terms ? [terms] : [];
    case "entities":
      return entities.length ? [truncateWords(entities.join(" "), MAX_QUERY)] : [];
    case "each-entity":
      return entities.slice(0, maxCalls);
    case "entity+term": {
      if (!entities.length) return [];
      const inEntities = new Set(entities.join(" ").toLowerCase().split(" "));
      const rest = [...new Set(terms.split(" "))].filter((t) => t && !inEntities.has(t.toLowerCase()));
      if (!rest.length) return [];
      const f = options.frequency ?? (() => 0);
      // The rarest term, ties to the earlier one: the most specific word the cue adds to the entity.
      let best = rest[0]!;
      for (const t of rest) if (f(t) < f(best)) best = t;
      return [truncateWords(`${entities[0]} ${best}`, MAX_QUERY)];
    }
    case "phrase":
      if (!options.quotes) return [];
      return entities.slice(0, maxCalls).map((e) => (e.includes(" ") ? `"${e}"` : e));
  }
}
