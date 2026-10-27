/**
 * Wave 22.2 URL hold-out soak.
 *
 *   bun test benchmarks/campaign/jit-url-soak.test.ts
 */
import { describe, expect, test } from "bun:test";
import { runJitUrlSoak, urlSoakTurns } from "./jit-url-soak";

describe("Wave 22.2 JIT URL hold-out", () => {
  test("precision ≥ 0.95; unique-work and vague stay empty; not github", () => {
    const r = runJitUrlSoak();
    for (const t of urlSoakTurns()) {
      expect(JSON.stringify(t.messages)).not.toContain("api.github.com");
    }
    expect(r.uniqueWorkSchemas).toBe(0);
    expect(r.vagueSchemas).toBe(0);
    expect(r.crossHits).toBe(0);
    expect(r.n).toBe(urlSoakTurns().length);
    expect(r.pass).toBe(true);
    expect(r.precision).toBeGreaterThanOrEqual(0.95);
  });
});
