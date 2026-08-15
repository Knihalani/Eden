const FACT_KEYS = [
  "title",
  "name",
  "state",
  "status",
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

/** One-line receipt when a PR/issue bundle is recognizable. */
export function compactReceipt(facts: unknown): string {
  if (!isPlainObject(facts)) return JSON.stringify(facts ?? null);
  const nested = isPlainObject(facts.s1);
  const s1 = nested ? facts.s1 : facts;
  const s2 = nested ? facts.s2 : facts.reviews;
  const s3 = nested && isPlainObject(facts.s3) ? facts.s3 : undefined;
  const s4 = nested ? facts.s4 : facts.files;
  if (!isPlainObject(s1)) {
    const json = JSON.stringify(facts);
    return json.length > 1200 ? json.slice(0, 1200) : json;
  }
  const number = typeof s1.number === "number" ? s1.number : undefined;
  const title = typeof s1.title === "string" ? s1.title : undefined;
  const reviews =
    isPlainObject(s2) && typeof s2.n === "number"
      ? s2.n
      : Array.isArray(s2)
        ? s2.length
        : typeof s2 === "number"
          ? s2
          : undefined;
  const CI = /^(success|failure|pending|error)$/;
  const values = Object.values(facts).filter(isPlainObject);
  const statusObj = values.find((v) => typeof v.state === "string" && CI.test(v.state) && typeof v.title !== "string");
  const state =
    (statusObj && typeof statusObj.state === "string" ? statusObj.state : undefined) ??
    (s3 && typeof s3.state === "string" && CI.test(s3.state) ? s3.state : undefined) ??
    (typeof s1.state === "string" && CI.test(s1.state) ? s1.state : undefined);
  const files =
    isPlainObject(s4) && typeof s4.n === "number"
      ? s4.n
      : Array.isArray(s4)
        ? s4.length
        : typeof s4 === "number"
          ? s4
          : typeof s1.n === "number" && !title
            ? s1.n
            : undefined;
  const sha =
    typeof s1.sha === "string"
      ? s1.sha
      : isPlainObject(s1.head) && typeof s1.head.sha === "string"
        ? s1.head.sha
        : undefined;
  if (title && state != null) {
    const bits: unknown[] = [number, title, reviews ?? "?", state];
    if (files != null) bits.push(files);
    if (sha) bits.push(sha);
    return bits.filter((b) => b !== undefined).join(" | ");
  }
  if (title && number != null) {
    const bits: unknown[] = [number, title, reviews ?? state ?? ""];
    return bits.filter((b) => b !== undefined && b !== "").join(" | ");
  }
  if (number != null && files != null) return `${number} | ${files}`;
  const json = JSON.stringify(facts);
  return json.length > 1200 ? json.slice(0, 1200) : json;
}
