/**
 * Test support: inputs built against the gate's own fast paths (docs/research/redact-perf.md), each a unit repeated to
 * a size: every keyword occurrence an anchor with the longest prefix it allows, candidates dense enough to pass the
 * scan back to the engine, combining marks and ligatures inside the prefilter's words (where a match's start is
 * counted back), the two-character anchors (`ey`, `s.`, `sk`), one non-space run (rule (d)'s walk), separators for
 * the assignment pass, and every token literal. `gate-linear.test.ts` holds the gate under a CPU-time ceiling on
 * them; `bench/gate.bench.ts` times them before and after.
 */
export const CRAFTED_UNITS: [string, string][] = [
  ["keyword then an operator", "key="],
  ["keywords back to back", "tokentoken"],
  ["the longest prefix before each keyword", `${"a".repeat(49)}key `],
  ["the longest prefix, no space", `${"a".repeat(50)}access`],
  ["prefix, keyword, operator, value", `${"a".repeat(45)}secret = ${"b".repeat(12)} `],
  ["combining marks inside a keyword", "k\u0301e\u0301y\u0301 "],
  ["marks before a keyword", `${"\u0301".repeat(40)}token `],
  ["ligatures beside a keyword", "\ufb01key\ufb02 "],
  ["two-character anchors", "eyJs.sk_SK"],
  ["one non-space run after a keyword", "x"],
  ["separators", "a:"],
  ["quoted values", 'token:"'],
  ["eden-keyword", "password is "],
  ["url userinfo", "a-b://"],
  ["token literals", "Bearer sk-ghp_xoxbasic AKIA"],
  ["generic-api-key, matching", `api_key = "${"0a1b2c3d4e".repeat(2)}" `],
];

/** `unit` repeated to `size` characters; the run of `x` gets a keyword in front (rule (d) runs on it). */
export function crafted(unit: string, size: number): string {
  const head = unit === "x" ? "secret " : "";
  return head + unit.repeat(Math.ceil((size - head.length) / unit.length)).slice(0, size - head.length);
}
