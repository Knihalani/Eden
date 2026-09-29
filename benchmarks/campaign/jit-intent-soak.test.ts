/**
 * Wave 22.2 NL-intent hold-out soak.
 *
 *   bun test benchmarks/campaign/jit-intent-soak.test.ts
 */
import { describe, expect, test } from "bun:test";
import { PRECISION_BAR } from "./jit-holdout-lib";
import { runJitIntentSoak, intentSoakTurns, PROGRAMS } from "./jit-intent-soak";

const FORBIDDEN = [
  "cus_8kQ2Lp0NaBcd",
  "s3://analytics-prod",
  "api.github.com",
  "kubectl",
  "jordan@acme.io",
];

describe("Wave 22.2 JIT intent hold-out", () => {
  test("precision ≥ bar; unique-work and vague stay empty; not id/cli/url worlds", () => {
    const turns = intentSoakTurns();
    const blob = JSON.stringify({ turns, programs: PROGRAMS });
    for (const s of FORBIDDEN) expect(blob).not.toContain(s);
    expect(PROGRAMS.length).toBeGreaterThanOrEqual(8);
    expect(turns.map((t) => t.label)).not.toContain("gh");
    expect(turns.map((t) => t.label)).not.toContain("kubectl");
    const firstTools = PROGRAMS.map((p) => p.sequence?.[0]);
    expect(new Set(firstTools).size).toBe(firstTools.length);

    const r = runJitIntentSoak();
    expect(r.uniqueWorkSchemas).toBe(0);
    expect(r.vagueSchemas).toBe(0);
    expect(r.crossHits).toBe(0);
    expect(r.n).toBe(turns.length);
    expect(r.n).toBeGreaterThanOrEqual(16);
    expect(r.pass).toBe(true);
    expect(r.precision).toBeGreaterThanOrEqual(PRECISION_BAR);
    expect(r.lines.some((l) => l.startsWith("verdict=PASS"))).toBe(true);
  });

  test("turns name the intent in English with a matching first tool", () => {
    const turns = intentSoakTurns();
    const english = {
      calendar: /standup|schedule|book/i,
      crm: /lead|pipeline|qualify/i,
      flags: /flag-checkout|roll|turn up/i,
      payments: /invoice|charge|bill|payment/i,
      inventory: /inventory|restock|purchase/i,
      seat: /seat/i,
      ticket: /ticket|page on-call/i,
      dns: /dns|zone/i,
    };
    for (const t of turns) {
      const text = JSON.stringify(t.messages);
      expect(text).toMatch(english[t.label as keyof typeof english]);
      const first = PROGRAMS.find((p) => p.name === t.expect)?.sequence?.[0];
      expect(t.call.function?.name).toBe(first);
    }
  });
});
