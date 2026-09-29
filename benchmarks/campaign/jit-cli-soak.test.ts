/**
 * Wave 22.2 CLI hold-out soak.
 *
 *   bun test benchmarks/campaign/jit-cli-soak.test.ts
 */
import { describe, expect, test } from "bun:test";
import { runJitCliSoak, cliSoakTurns } from "./jit-cli-soak";

describe("Wave 22.2 JIT CLI hold-out", () => {
  test("precision ≥ 0.95; unique-work and vague stay empty; no kubectl", () => {
    const r = runJitCliSoak();
    expect(cliSoakTurns().map((t) => t.label)).not.toContain("kubectl");
    expect(r.uniqueWorkSchemas).toBe(0);
    expect(r.vagueSchemas).toBe(0);
    expect(r.crossHits).toBe(0);
    expect(r.n).toBe(cliSoakTurns().length);
    expect(r.pass).toBe(true);
    expect(r.precision).toBeGreaterThanOrEqual(0.95);
  });
});
