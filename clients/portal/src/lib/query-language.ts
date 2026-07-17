/**
 * U08 query language v1 — parse `?q=` filter strings into trace filters.
 *
 * Examples:
 *   latency:>2 agent:support status:error tag:prod user:usr_123
 */

export type ParsedQueryFilters = {
  realm?: string;
  outcome?: string;
  agent_id?: string;
  tag?: string;
  user_id?: string;
  latency_gt_ms?: number;
  latency_lt_ms?: number;
  cost_gt_usd?: number;
  cost_lt_usd?: number;
  text?: string;
};

/** Field docs for autocomplete (W14). */
export const QUERY_LANGUAGE_FIELDS: Array<{
  field: string;
  docs: string;
  example: string;
}> = [
  { field: "agent", docs: "Filter by agent id", example: "agent:support" },
  { field: "status", docs: "Trace/span outcome", example: "status:error" },
  { field: "realm", docs: "Environment realm", example: "realm:prod" },
  { field: "tag", docs: "Custom tag", example: "tag:canary" },
  { field: "user", docs: "End-user id", example: "user:usr_123" },
  { field: "latency", docs: "Duration in seconds (use :> / :<)", example: "latency:>2" },
  { field: "cost", docs: "Cost in USD (use :> / :<)", example: "cost:>0.05" },
  { field: "text", docs: "Free-text span body match", example: 'text:"timeout"' },
];

export function suggestQueryCompletions(draft: string): Array<{
  label: string;
  insert: string;
  docs: string;
}> {
  const trimmed = draft.trimEnd();
  const lastToken = trimmed.split(/\s+/).pop() ?? "";
  const prefix = lastToken.includes(":") ? lastToken.split(":")[0]! : lastToken;
  const lower = prefix.toLowerCase();
  return QUERY_LANGUAGE_FIELDS.filter(
    (f) => !prefix || f.field.startsWith(lower) || lower.length === 0,
  ).map((f) => ({
    label: f.field,
    insert: lastToken.includes(":") ? `${f.field}:` : `${trimmed ? trimmed.replace(/\S+$/, "") : ""}${f.example}`.trim(),
    docs: f.docs,
  }));
}

/** Serialize for Typesense / spans search API params. */
export function parsedToSpanSearchParams(parsed: ParsedQueryFilters): {
  q: string;
  agent?: string;
  outcome?: string;
} {
  const q = parsed.text?.trim() || serializeQueryLanguage({
    tag: parsed.tag,
    realm: parsed.realm,
    user_id: parsed.user_id,
    latency_gt_ms: parsed.latency_gt_ms,
    latency_lt_ms: parsed.latency_lt_ms,
    cost_gt_usd: parsed.cost_gt_usd,
    cost_lt_usd: parsed.cost_lt_usd,
  }) || "*";
  return {
    q: q || "*",
    ...(parsed.agent_id ? { agent: parsed.agent_id } : {}),
    ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
  };
}

const TOKEN =
  /(\w+(?:\.\w+)?):([<>=!]+)?("([^"]+)"|(\S+))/g;

export function parseQueryLanguage(q: string): ParsedQueryFilters {
  const out: ParsedQueryFilters = {};
  const trimmed = q.trim();
  if (!trimmed) return out;

  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(trimmed)) !== null) {
    const field = match[1].toLowerCase();
    const op = match[2] ?? "";
    const value = match[4] ?? match[5] ?? "";

    if (field === "agent" || field === "agent_id") {
      out.agent_id = value;
    } else if (field === "status" || field === "outcome") {
      out.outcome = value;
    } else if (field === "realm") {
      out.realm = value;
    } else if (field === "tag") {
      out.tag = value;
    } else if (field === "user" || field === "user_id") {
      out.user_id = value;
    } else if (field === "latency" || field === "duration") {
      const ms = Number(value) * (value.includes(".") ? 1 : 1000);
      if (!Number.isNaN(ms)) {
        if (op === ">" || op === ">=") out.latency_gt_ms = ms;
        else if (op === "<" || op === "<=") out.latency_lt_ms = ms;
      }
    } else if (field === "cost" || field === "cost_usd") {
      const usd = Number(value);
      if (!Number.isNaN(usd)) {
        if (op === ">" || op === ">=") out.cost_gt_usd = usd;
        else if (op === "<" || op === "<=") out.cost_lt_usd = usd;
      }
    } else if (field === "text") {
      out.text = value;
    }
  }

  const unconsumed = trimmed.replace(TOKEN, " ").trim();
  if (unconsumed && !out.text) out.text = unconsumed;

  return out;
}

export function serializeQueryLanguage(filters: ParsedQueryFilters): string {
  const parts: string[] = [];
  if (filters.agent_id) parts.push(`agent:${filters.agent_id}`);
  if (filters.outcome) parts.push(`status:${filters.outcome}`);
  if (filters.realm) parts.push(`realm:${filters.realm}`);
  if (filters.tag) parts.push(`tag:${filters.tag}`);
  if (filters.user_id) parts.push(`user:${filters.user_id}`);
  if (filters.latency_gt_ms != null) {
    parts.push(`latency:>${(filters.latency_gt_ms / 1000).toFixed(2)}`);
  }
  if (filters.latency_lt_ms != null) {
    parts.push(`latency:<${(filters.latency_lt_ms / 1000).toFixed(2)}`);
  }
  if (filters.cost_gt_usd != null) {
    parts.push(`cost:>${filters.cost_gt_usd}`);
  }
  if (filters.cost_lt_usd != null) {
    parts.push(`cost:<${filters.cost_lt_usd}`);
  }
  if (filters.text) parts.push(`text:"${filters.text}"`);
  return parts.join(" ");
}
