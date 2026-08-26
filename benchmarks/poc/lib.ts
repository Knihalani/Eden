/**
 * Shared helpers for the 10-improvement POC suite.
 *
 * Ground rules for every POC in this directory:
 * - Drive the REAL production code (packages/core, packages/compile,
 *   packages/wrap), never a reimplementation of the algorithm under test.
 * - Anything that cannot be measured against a live system (e.g. database
 *   network round trips) is modeled EXPLICITLY and labeled as modeled, with
 *   the pure-JS portion measured for real.
 * - Every script prints a verdict line that a human can check at a glance.
 */

/** High-resolution wall clock in ms. */
export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export type BenchResult = {
  label: string;
  ms: number;
  detail?: string;
};

export function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

export function printRow(label: string, value: string): void {
  console.log(`  ${label.padEnd(46)} ${value}`);
}

export function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function speedup(before: number, after: number): number {
  return before / after;
}

/** Deterministic PRNG so every run of every POC is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
