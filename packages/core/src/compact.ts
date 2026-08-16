import type { TypedPrRow } from "./plan";

/** Combined CI from GitHub commit status — never PR `open`/`closed`. */
export const CI_STATE = /^(success|failure|pending|error)$/;

const FACT_KEYS = [
  "title",
  "name",
  "state",
  "status",
  "combined_state",
  "conclusion",
  "number",
  "id",
  "login",
  "ok",
  "message",
  "error",
  "sha",
  "reviews",
  "files",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickFacts(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) {
    const facts = value.slice(0, 3).map((row) => pickFacts(row, depth + 1));
    return { n: value.length, sample: facts };
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of FACT_KEYS) {
    if (k in value && !isPlainObject(value[k]) && !Array.isArray(value[k])) out[k] = value[k];
  }
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) out[k] = { n: v.length };
    else if (isPlainObject(v) && depth < 2) {
      const nested = pickFacts(v, depth + 1);
      if (nested && typeof nested === "object" && Object.keys(nested as object).length) out[k] = nested;
    }
  }
  return out;
}

/** Short JSON the model should see. Full densified body stays on Eden / in tool_run. */
export function modelFacing(value: unknown, maxChars = 2500): { text: string; facts: unknown; truncated: boolean } {
  const facts = pickFacts(value);
  const factsJson = JSON.stringify(facts);
  if (factsJson.length <= maxChars) return { text: factsJson, facts, truncated: factsJson.length < JSON.stringify(value).length };
  return {
    text: JSON.stringify({ n: "truncated", hint: "full result stored on Eden" }),
    facts,
    truncated: true,
  };
}

function countish(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  if (isPlainObject(v) && typeof v.n === "number") return v.n;
  return undefined;
}

function ciState(v: unknown): string | undefined {
  if (typeof v === "string" && CI_STATE.test(v)) return v;
  if (!isPlainObject(v)) return undefined;
  const s = v.state ?? v.combined_state;
  return typeof s === "string" && CI_STATE.test(s) ? s : undefined;
}

/** Typed PR row the agent can write straight to prs.json. CI state never uses PR `open`. */
export function prRowFromFacts(facts: unknown, fallbackNumber?: string): TypedPrRow | null {
  if (!isPlainObject(facts)) return null;
  const nested = isPlainObject(facts.s1);
  const s1 = nested ? facts.s1 : facts;
  const s2 = nested ? facts.s2 : facts.reviews;
  const s3 = nested && isPlainObject(facts.s3) ? facts.s3 : undefined;
  const s4 = nested ? facts.s4 : facts.files;
  if (!isPlainObject(s1)) return null;
  const number =
    typeof s1.number === "number"
      ? s1.number
      : fallbackNumber && /^\d+$/.test(fallbackNumber)
        ? Number(fallbackNumber)
        : undefined;
  const title = typeof s1.title === "string" ? s1.title : undefined;
  const reviews = countish(s2);
  const values = Object.values(facts).filter(isPlainObject);
  const statusObj = values.find((v) => ciState(v) && typeof v.title !== "string");
  const status =
    ciState(statusObj) ??
    ciState(s3) ??
    ciState(s1.state) ??
    ciState(s1) ??
    (typeof s1.status === "string" && CI_STATE.test(s1.status) ? s1.status : undefined);
  const files = countish(s4);
  const sha =
    typeof s1.sha === "string"
      ? s1.sha
      : isPlainObject(s1.head) && typeof s1.head.sha === "string"
        ? s1.head.sha
        : undefined;
  if (number == null || !title || !status) return null;
  const row: TypedPrRow = { number, title, reviews: reviews ?? 0, status };
  if (files != null) row.files = files;
  if (sha) row.sha = sha;
  return row;
}

export function prRowsFromFacts(facts: unknown, issues?: string[]): TypedPrRow[] {
  if (isPlainObject(facts) && Array.isArray(facts.rows)) {
    return facts.rows
      .map((f, i) => prRowFromFacts(f, issues?.[i]))
      .filter((r): r is TypedPrRow => r !== null);
  }
  const one = prRowFromFacts(facts, issues?.[0]);
  return one ? [one] : [];
}

export function bundleJson(rows: TypedPrRow[]): string {
  return `${JSON.stringify(
    rows.map((r) => {
      const out: Record<string, unknown> = {
        number: r.number,
        title: r.title,
        reviews: r.reviews,
        status: r.status,
      };
      if (r.files != null) out.files = r.files;
      return out;
    }),
  )}\n`;
}

/** One-line receipt when a PR/issue bundle is recognizable. */
export function compactReceipt(facts: unknown): string {
  const row = prRowFromFacts(facts);
  if (row) {
    const bits: Array<string | number> = [row.number, row.title, row.reviews, row.status];
    if (row.files != null) bits.push(row.files);
    if (row.sha) bits.push(row.sha);
    return bits.join(" | ");
  }
  if (!isPlainObject(facts)) return JSON.stringify(facts ?? null);
  const s1 = isPlainObject(facts.s1) ? facts.s1 : facts;
  if (isPlainObject(s1) && typeof s1.number === "number" && typeof s1.n === "number" && typeof s1.title !== "string") {
    return `${s1.number} | ${s1.n}`;
  }
  if (isPlainObject(s1) && typeof s1.number === "number" && typeof s1.title === "string") {
    return [s1.number, s1.title, countish(facts.s2) ?? ""].filter((b) => b !== "").join(" | ");
  }
  const json = JSON.stringify(facts);
  return json.length > 1200 ? json.slice(0, 1200) : json;
}
