/** The secret gate (packages/redact) before and after the Aho–Corasick keyword prefilter, on the same rules. */
import { redact } from "../../redact/src/redact";
import { sanitizeForStore, secretRules } from "../../redact/src/secrets";
import { bench, corpus, report } from "./harness";

/** sanitizeForStore as it was: one `includes` per keyword over the lowercased text. */
function before(text: string): unknown {
  const lower = text.toLowerCase();
  const spans = secretRules()
    .filter((rule) => !rule.keywords.length || rule.keywords.some((word) => lower.includes(word)))
    .flatMap((rule) => rule.spans(text));
  return redact(spans.length ? text : text);
}

const results = [];
for (const size of [256, 2048, 16384]) {
  const text = corpus(size);
  results.push(
    bench(`gate before (includes per keyword)  ${size}B`, () => before(text), { batch: 10 }),
    bench(`gate after  (Aho-Corasick prefilter) ${size}B`, () => sanitizeForStore(text), { batch: 10 }),
  );
}
report(results);
