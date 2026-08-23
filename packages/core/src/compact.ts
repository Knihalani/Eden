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

function rollupCheckConclusions(rows: unknown[]): string | undefined {
  const conclusions: string[] = [];
  const statuses: string[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    if (typeof row.conclusion === "string") conclusions.push(row.conclusion);
    if (typeof row.status === "string") statuses.push(row.status);
  }
  if (!conclusions.length && !statuses.length) return undefined;
  if (conclusions.some((c) => /^(failure|cancelled|timed_out|startup_failure|error)$/.test(c))) return "failure";
  if (statuses.some((s) => /^(queued|in_progress|pending)$/.test(s))) return "pending";
  if (conclusions.some((c) => c === "action_required")) return "pending";
  if (conclusions.length && conclusions.every((c) => /^(success|skipped|neutral)$/.test(c))) return "success";
  return undefined;
}

const SKIP_SCALAR = /^(body|html_url|url|avatar_url|node_id|diff|patch|content|readme|description)$/i;

function pickScalar(k: string, v: unknown, t: Truncation): unknown {
  if (SKIP_SCALAR.test(k)) return undefined;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string" && v.length > 0 && v.length < 160) return v;
  // A long string was dropped on purpose, but it *was* dropped: the model sees
  // less than the tool returned. Count it rather than inferring truncation
  // later from JSON sizes.
  if (typeof v === "string" && v.length >= 160) t.longString = true;
  return undefined;
}

/** Which caps pickFacts actually hit. Truncation is structural, not a size guess. */
type Truncation = { depth: boolean; sample: boolean; longString: boolean };

function pickFacts(value: unknown, depth = 0, t: Truncation = { depth: false, sample: false, longString: false }): unknown {
  if (depth > 4) {
    t.depth = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 3) t.sample = true;
    const facts = value.slice(0, 3).map((row) => pickFacts(row, depth + 1, t));
    const out: Record<string, unknown> = { n: value.length, sample: facts };
    const rolled = rollupCheckConclusions(value);
    if (rolled) out.state = rolled;
    return out;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of FACT_KEYS) {
    if (k in value && !isPlainObject(value[k]) && !Array.isArray(value[k])) out[k] = value[k];
  }
  for (const [k, v] of Object.entries(value)) {
    if (k in out) continue;
    const scalar = pickScalar(k, v, t);
    if (scalar !== undefined) out[k] = scalar;
    else if (Array.isArray(v)) out[k] = pickFacts(v, depth + 1, t);
    else if (isPlainObject(v) && depth < 2) {
      const nested = pickFacts(v, depth + 1, t);
      if (nested && typeof nested === "object" && Object.keys(nested as object).length) out[k] = nested;
    }
  }
  return out;
}

/** Short JSON the model should see. Full densified body stays on Eden / in tool_run. */
export function modelFacing(value: unknown, maxChars = 2500): { text: string; facts: unknown; truncated: boolean } {
  const t: Truncation = { depth: false, sample: false, longString: false };
  const facts = pickFacts(value, 0, t);
  const factsJson = JSON.stringify(facts);
  // The old flag compared the two stringify sizes, which is the wrong question:
  // it said "not truncated" whenever the picked facts happened to serialize
  // shorter than the raw body — true for every sampled or depth-capped result,
  // exactly the cases where information was discarded. Ask the walk instead.
  const truncated =
    t.depth || t.sample || t.longString || factsJson.length > maxChars;
  if (factsJson.length <= maxChars) return { text: factsJson, facts, truncated };
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
  if (typeof s === "string" && CI_STATE.test(s)) return s;
  if (isPlainObject(v.check_runs)) return ciState(v.check_runs);
  return undefined;
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

export function compactRowFromFacts(facts: unknown, fallbackId?: string): Record<string, unknown> | null {
  const pr = prRowFromFacts(facts, fallbackId);
  if (pr) {
    const out: Record<string, unknown> = {
      number: pr.number,
      title: pr.title,
      reviews: pr.reviews,
      status: pr.status,
    };
    if (pr.files != null) out.files = pr.files;
    return out;
  }
  if (!isPlainObject(facts)) return null;
  const s1 = isPlainObject(facts.s1) ? facts.s1 : facts;
  if (!isPlainObject(s1)) return null;
  const row: Record<string, unknown> = {};
  const rawId = s1.id ?? s1.number ?? fallbackId;
  if (rawId != null && rawId !== "") {
    row.id = typeof rawId === "string" && /^\d+$/.test(rawId) ? Number(rawId) : rawId;
  }
  if (typeof s1.title === "string") row.title = s1.title;
  else if (typeof s1.name === "string") row.name = s1.name;
  for (const k of ["status", "state", "total", "email"]) {
    if (s1[k] != null && (typeof s1[k] === "string" || typeof s1[k] === "number")) row[k] = s1[k];
  }
  if (isPlainObject(facts.s2) && typeof facts.s2.n === "number") row.count = facts.s2.n;
  return Object.keys(row).length ? row : null;
}

export function receiptJson(rows: Array<Record<string, unknown>>): string {
  return `${JSON.stringify(rows)}\n`;
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
