/**
 * The gate's one-time costs, one gate per process so neither warms the other: `before` (the reference gate) or `after`
 * (the gate now). Import, the first call (rules built, the call's rules compiled), `warmGate`, one warm call, and the
 * heap the gate holds once warmed and used on the realistic corpus (after a full GC).
 *
 *   env -u BUN_OPTIONS bun packages/redact/bench/gate-startup.bench.ts before|after
 */
import { KINDS, sample } from "./corpus.ts";

const which = process.argv[2] ?? "after";
if (which !== "before" && which !== "after") throw new Error("before or after");
const texts = KINDS.map((kind) => sample(kind, 16_384, 3));
const heap = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};
const h0 = heap();
const t0 = performance.now();
const gate = which === "after" ? await import("../src/secrets") : await import("../src/secrets.reference");
const t1 = performance.now();
gate.sanitizeForStore("first call: the staging password is hunter22");
const t2 = performance.now();
gate.warmGate();
const t3 = performance.now();
gate.sanitizeForStore("Hi Dana, the api key for staging is in the vault; token=abc123def456ghi789");
const t4 = performance.now();
for (let round = 0; round < 20; round++) for (const text of texts) gate.sanitizeForStore(text);
const held = heap() - h0;
const ms = (x: number) => `${x.toFixed(1)} ms`;
console.log(
  `${which}: import ${ms(t1 - t0)}, first call ${ms(t2 - t1)}, warmGate ${ms(t3 - t2)}, a warm call ` +
    `${ms(t4 - t3)}; heap held ${(held / 1_048_576).toFixed(2)} MB`,
);
