/**
 * Heap kept by the secret gate after realistic and crafted input, per engine choice: re2js keeps a lazy DFA cache
 * per pattern (budgeted at 8 MB of its own accounting each), JavaScript's RegExp keeps none. One choice per process
 * so the numbers do not mix:
 *
 *   bun packages/primitives/bench/gate-memory.bench.ts js|re2|d23
 */
import {
  backtrackingEngine,
  everywhere,
  GATE_ENGINES,
  gateOf,
  linearEngine,
  rulesWith,
  secretRules,
} from "../../redact/src/secrets";
import { corpus } from "./harness";

const which = process.argv[2] ?? "d23";
const choice =
  which === "js" ? everywhere(backtrackingEngine) : which === "re2" ? everywhere(linearEngine) : GATE_ENGINES;
const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
const heap = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

const h0 = heap();
const gate = gateOf(rulesWith(choice));
const KEYWORDS = [...new Set(secretRules().flatMap((rule) => rule.keywords))];
// mulberry32, seeded: the same texts every run.
let x = 9;
const rnd = () => {
  x = (x + 0x6d2b79f5) >>> 0;
  let t = Math.imul(x ^ (x >>> 15), 1 | x);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Realistic: 5,000 emails of 256 B–8 KB, one in ten with a keyword-and-value line.
for (let i = 0; i < 5_000; i++) {
  const text = corpus(256 + Math.floor(rnd() * 7_936), { seed: i + 1, nonAscii: i % 5 === 0 });
  gate.sanitizeForStore(i % 10 === 0 ? `${text}\n${KEYWORDS[i % KEYWORDS.length]}_key = "${text.slice(0, 32)}"` : text);
}
const h1 = heap();
// Crafted: 3 MB of random text over the rules' class characters with 5% gitleaks keywords, so every rule runs.
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=._-:\"' \n\t@";
const t0 = performance.now();
for (let k = 0; k < 60; k++) {
  let text = "";
  while (text.length < 50_000) {
    text +=
      rnd() < 0.05 ? KEYWORDS[Math.floor(rnd() * KEYWORDS.length)] : alphabet[Math.floor(rnd() * alphabet.length)];
  }
  gate.sanitizeForStore(text);
}
const crafted = performance.now() - t0;
const h2 = heap();
// Used after the last measurement, so the collector cannot free the gate (and its DFA caches) before it.
gate.sanitizeForStore("done");
console.log(
  `${which}: heap ${mb(h0)} at start, ${mb(h1)} after 5,000 emails, ${mb(h2)} after 3 MB of crafted text ` +
    `(${(crafted / 1_000).toFixed(1)} s); rss ${mb(process.memoryUsage().rss)}`,
);
