/**
 * P4.3's evidence gate ships in shadow (`gate.tau`, `memory-flags.ts`): a store admits as before it and records what
 * it would drop. The gate's own tests call `tauGateOn()` at a file's or a describe's top to run with
 * `EDEN_FLAG_GATE_TAU=on`, and restore the variable after it.
 */
import { afterAll, beforeAll } from "bun:test";

export function tauGateOn(): void {
  const before = process.env.EDEN_FLAG_GATE_TAU;
  beforeAll(() => {
    process.env.EDEN_FLAG_GATE_TAU = "on";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.EDEN_FLAG_GATE_TAU;
    else process.env.EDEN_FLAG_GATE_TAU = before;
  });
}
