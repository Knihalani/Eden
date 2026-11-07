import { describe, expect, test } from "bun:test";
import { Histogram, RollingHistogram } from "./histogram";

/** The histogram before D261, kept as the oracle: 1,024 counters from the first sample, one scan per quantile. */
const BUCKETS = 1_024;
const MIN_MS = 0.001;
const MAX_MS = 600_000;
const SCALE = (BUCKETS - 1) / Math.log(MAX_MS / MIN_MS);
const bucketOf = (ms: number) =>
  !(ms > MIN_MS) ? 0 : ms >= MAX_MS ? BUCKETS - 1 : Math.floor(Math.log(ms / MIN_MS) * SCALE);
const upperOf = (b: number) => MIN_MS * Math.exp((b + 1) / SCALE);
function oracle(samples: number[][], q: number): number {
  const counts = new Uint32Array(BUCKETS);
  let total = 0;
  for (const xs of samples) for (const x of xs) (counts[bucketOf(x)]!++, total++);
  if (total === 0) return NaN;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let b = 0; b < BUCKETS; b++) if ((seen += counts[b]!) >= rank) return upperOf(b);
  return MAX_MS;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Histogram with few samples (D261)", () => {
  test("every quantile equals the dense histogram's, from 0 to past the switch to counters", () => {
    const r = rng(3);
    const draw = () => (r() < 0.05 ? [0, -1, 1e9, 0.0005][Math.floor(r() * 4)]! : 1 + 2_000 * r() ** 3);
    for (const n of [0, 1, 2, 3, 4, 5, 8, 31, 63, 64, 65, 66, 200]) {
      for (let rep = 0; rep < 20; rep++) {
        const xs = Array.from({ length: n }, draw);
        const h = new Histogram();
        for (const x of xs) h.record(x);
        expect(h.total).toBe(n);
        for (const q of [0, 0.01, 0.25, 0.5, 0.9, 0.95, 0.99, 1]) {
          const want = oracle([xs], q);
          if (Number.isNaN(want)) expect(h.quantile(q)).toBeNaN();
          else expect(h.quantile(q)).toBe(want);
        }
      }
    }
  });

  test("a rolling histogram over a few and a dense window answers as one dense histogram would", () => {
    const r = rng(9);
    for (const [a, b] of [
      [3, 0],
      [0, 3],
      [3, 5],
      [70, 4],
      [4, 70],
      [100, 100],
    ] as const) {
      let now = 0;
      const h = new RollingHistogram(1_000, () => now);
      const first = Array.from({ length: a }, () => 1 + 500 * r());
      for (const x of first) h.record(x);
      now = 1_500;
      const second = Array.from({ length: b }, () => 1 + 500 * r());
      for (const x of second) h.record(x);
      for (const q of [0.5, 0.95, 0.99]) {
        const want = oracle([first, second], q);
        if (Number.isNaN(want)) expect(h.quantile(q)).toBeNaN();
        else expect(h.quantile(q)).toBe(want);
      }
    }
  });

  test("reset empties it, and it records and answers again", () => {
    const h = new Histogram();
    for (let i = 1; i <= 100; i++) h.record(i);
    h.reset();
    expect(h.total).toBe(0);
    expect(h.quantile(0.5)).toBeNaN();
    h.record(42);
    expect(h.quantile(0.5)).toBe(oracle([[42]], 0.5));
  });
});
