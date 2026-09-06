import { redact, takeSignals } from "@eden/ir";
import { createState, wrapTools } from "./index.ts";

const N = 80_000;
async function ping() {
  return { pong: true };
}
const args = {};

let t0 = performance.now();
for (let i = 0; i < N; i++) await ping();
const raw = ((performance.now() - t0) * 1000) / N;

t0 = performance.now();
for (let i = 0; i < N; i++) {
  redact(args);
  redact({ pong: true });
}
const red = ((performance.now() - t0) * 1000) / N;

const events = Array.from({ length: 8 }, () => ({ name: "ping", args: {}, ok: true as const, duration_ms: 0 }));
const seen = new Set<string>();
t0 = performance.now();
for (let i = 0; i < N; i++) takeSignals(events, { duration_ms: 1, llmCalls: 0 }, seen);
const sig = ((performance.now() - t0) * 1000) / N;

const state = createState({ programs: [] });
const w = wrapTools({ ping }, state);
t0 = performance.now();
for (let i = 0; i < N; i++) await w.ping.execute({});
const wrap = ((performance.now() - t0) * 1000) / N;

process.stdout.write(
  JSON.stringify(
    { raw: +raw.toFixed(2), redact: +red.toFixed(2), takeSignals: +sig.toFixed(2), wrap: +wrap.toFixed(2), overhead: +(wrap - raw).toFixed(2) },
    null,
    2,
  ) + "\n",
);
