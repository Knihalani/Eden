/**
 * `MultiMatcher` before and after D1841 interleaved in one process (the A/B to trust): `matcher.reference.ts` (the
 * matcher before, kept as the oracle) against the matcher with its transitions packed (next row and output bit in one
 * load), on the gitleaks keywords, as `markHits`; and `scan` (hits, first-hit list, every occurrence's start kept).
 * Medians of 9 alternating rounds, µs a call.
 *
 *   env -u BUN_OPTIONS bun packages/primitives/bench/matcher-ab.bench.ts
 */
import { secretRules } from "../../redact/src/secrets.reference";
import { MultiMatcher } from "../src/matcher";
import { MultiMatcher as ReferenceMatcher } from "../src/matcher.reference";
import { corpus } from "./harness";

const keywords = [...new Set(secretRules().flatMap((rule) => rule.keywords))];
const before = new ReferenceMatcher(keywords);
const after = new MultiMatcher(keywords);
const hits = new Uint8Array(keywords.length);
const firsts = new Int32Array(keywords.length);
const keep = new Uint8Array(keywords.length).fill(1);
let kept = 0;
const sink = { add: () => void kept++ };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

console.log(
  `${keywords.length} keywords\n\n| Text | markHits before | markHits after | scan (all kept) |\n|---|---:|---:|---:|`,
);
for (const [name, text] of [
  ["256 B", corpus(256)],
  ["2 KB", corpus(2_048)],
  ["16 KB", corpus(16_384)],
  ["2 KB, 10% non-ASCII", corpus(2_048, { nonAscii: true })],
] as const) {
  const reps = Math.floor(2_000_000 / text.length);
  const runs: [() => void, number[]][] = [
    [() => (hits.fill(0), before.markHits(text, hits)), []],
    [() => (hits.fill(0), after.markHits(text, hits)), []],
    [() => (hits.fill(0), after.scan(text, hits, firsts, keep, sink)), []],
  ];
  for (let round = 0; round < 9; round++) {
    for (const [run, times] of round % 2 === 0 ? runs : [...runs].reverse()) {
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) run();
      times.push(((performance.now() - t0) * 1000) / reps);
    }
  }
  console.log(`| ${name} | ${runs.map(([, times]) => `${median(times).toFixed(2)} µs`).join(" | ")} |`);
}
void kept;
