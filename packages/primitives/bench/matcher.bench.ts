import { secretRules } from "../../redact/src/secrets";
import { MultiMatcher } from "../src/matcher";
import { bench, corpus, report } from "./harness";

const keywords = [...new Set(secretRules().flatMap((r) => r.keywords))];
const matcher = new MultiMatcher(keywords);
const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const alternation = new RegExp(escaped.join("|"), "gi");
const hits = new Uint8Array(keywords.length);
console.log(`${keywords.length} keywords, ${matcher.stateCount} states`);
const results = [];
for (const size of [256, 2048, 16384]) {
  const text = corpus(size);
  results.push(
    bench(
      `includes loop over lowercased text  ${size}B`,
      () => {
        const lower = text.toLowerCase();
        let n = 0;
        for (const k of keywords) if (lower.includes(k)) n++;
        return n;
      },
      { batch: 20 },
    ),
    bench(
      `one regex alternation /k1|k2|…/gi   ${size}B`,
      () => {
        alternation.lastIndex = 0;
        let n = 0;
        while (alternation.exec(text) !== null) n++;
        return n;
      },
      { batch: 20 },
    ),
    bench(
      `MultiMatcher.markHits (Aho-Corasick) ${size}B`,
      () => {
        hits.fill(0);
        return matcher.markHits(text, hits);
      },
      { batch: 20 },
    ),
  );
}
// `scan` (hits, first-hit list, starts for kept patterns), nothing kept: on ordinary text, and on 64 KB dense in one
// literal (`sk-` repeated), where D1850's quiet states stop calling `emit` once each pattern there is hit.
const firsts = new Int32Array(keywords.length);
const none = new Uint8Array(keywords.length);
const sink = { add: () => {} };
for (const [name, text] of [
  ["corpus 16384B", corpus(16_384)],
  ["sk- dense 64KB", "sk-".repeat(21_846)],
] as const) {
  results.push(
    bench(
      `MultiMatcher.scan, nothing kept     ${name}`,
      () => {
        hits.fill(0);
        return matcher.scan(text, hits, firsts, none, sink);
      },
      { batch: 5, batches: 100 },
    ),
  );
}
report(results);
