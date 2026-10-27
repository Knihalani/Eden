/**
 * Where per-item CPU went before the primitives: the engine's regex tokenizer and entity extractor, the secret gate as
 * it was (per-keyword `includes`, reconstructed from the same rules as bench/gate.bench.ts), and native string ops.
 */
import { contentTerms, extractEntities } from "../../engine/src/text";
import { redact } from "../../redact/src/redact";
import { secretRules } from "../../redact/src/secrets";
import { bench, corpus, report } from "./harness";

const text = corpus(2048);
function gateBefore(t: string): unknown {
  const lower = t.toLowerCase();
  for (const rule of secretRules())
    if (!rule.keywords.length || rule.keywords.some((w) => lower.includes(w))) rule.spans(t);
  return redact(t);
}
const enc = new TextEncoder();
report([
  bench("secret gate, before (includes per keyword)", () => gateBefore(text), { batch: 10 }),
  bench("engine contentTerms (regex)", () => contentTerms(text), { batch: 20 }),
  bench("engine extractEntities (regex)", () => extractEntities(text), { batch: 20 }),
  bench("String.normalize('NFKC')", () => text.normalize("NFKC"), { batch: 200 }),
  bench("String.toLowerCase", () => text.toLowerCase(), { batch: 200 }),
  bench("Bun.hash (wyhash)", () => Bun.hash(text), { batch: 200 }),
  bench("TextEncoder.encode", () => enc.encode(text), { batch: 200 }),
]);
