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
