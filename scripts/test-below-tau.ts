/**
 * For test files of behaviour other than A7 §4's gate (forget, supersession, labels, lanes, the wrap, …) on stores of
 * a few rows: since P4.3 a row is admitted on MEDIUM evidence only when its BM25F sum reaches τ_repo, which takes about
 * two matched words at any store size, and these files' cues name one ("what is auth"). `cuesBelowTau()`, called at a
 * file's top, runs the file with `EDEN_MEMORY_TAU=0` (`memory-tau.ts`: every row with MEDIUM evidence passes τ; the
 * relative cut still holds) and restores the variable after it. The gate's own tests leave it unset.
 */
import { afterAll, beforeAll } from "bun:test";

export function cuesBelowTau(): void {
  const before = process.env.EDEN_MEMORY_TAU;
  beforeAll(() => {
    process.env.EDEN_MEMORY_TAU = "0";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.EDEN_MEMORY_TAU;
    else process.env.EDEN_MEMORY_TAU = before;
  });
}
