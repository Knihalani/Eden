/**
 * M35.1 no-lift annex. Dated 2026-09-22.
 * Asserts NEGATIVE.md shape and that a Δ≈0 label matches a real 0-byte on/off inject delta.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_PATH,
  NEGATIVE_PATH,
  REQUIRED_CASE_IDS,
  loadNegativeFixture,
  negativeFixtureIssues,
  runNegative,
  withinBand,
  type NegativeRow,
} from "./run-negative.ts";

const REGISTERED = "2026-09-22";

function honest(row: NegativeRow): boolean {
  if (row.verdict === "Δ≈0") {
    return row.delta_bytes === 0
      && row.body_delta_bytes === 0
      && row.baseline.packet_bytes === 0
      && row.probe.packet_bytes === 0
      && row.baseline.body_packet_bytes === 0
      && row.probe.body_packet_bytes === 0
      && row.leftover.length === 0
      && row.body_leftover.length === 0
      && row.baseline.identity
      && row.probe.identity
      && row.baseline.body_identity
      && row.probe.body_identity
      && row.baseline.added_system_bytes === 0
      && row.probe.added_system_bytes === 0;
  }
  if (row.verdict === "LOSS") return row.expect === "MEASURE";
  return row.verdict === "FAIL";
}

describe("M35.1 no-lift negative annex", () => {
  test("fixture pre-registers expects before the measured verdict (2026-09-22)", () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    const fix = loadNegativeFixture();
    expect(negativeFixtureIssues(fix)).toEqual([]);
    expect(fix.dated_registered).toBe(REGISTERED);
    expect(fix.api_under_test).toBe("openMemory.inject");
    expect(fix.k).toBe("default");
    expect(fix.k_default).toBe(6);
    expect(fix.materiality).toBe(0.01);
    expect(fix.product).toEqual(["openMemory", "inject", "injectBody"]);
    expect(fix.named_not_scored).toEqual(["hook-inject"]);
    expect(fix.cases.find((c) => c.id === "empty-math")?.expect).toBe("DELTA_ZERO");
    expect(fix.cases.find((c) => c.id === "aa-off")?.expect).toBe("DELTA_ZERO");
    expect(fix.cases.find((c) => c.id === "empty-coding")?.expect).toBe("DELTA_ZERO");
    expect(fix.cases.find((c) => c.id === "seeded-math")?.expect).toBe("MEASURE");
    expect(fix.cases.find((c) => c.id === "seeded-openssl")?.expect).toBe("MEASURE");
    expect(fix.seed_liveness.cue).toBe("What sqlite database do we use?");
    expect(fix.seed_liveness.needle).toBe("sqlite");
    expect(fix.cases.find((c) => c.id === "empty-math")?.cue).toBe("what's 2+2?");
    expect(withinBand(0, 0)).toBe(true);
    expect(withinBand(0, 1)).toBe(false);
  });

  test("runner files an on/off Δ table and does not invent Δ≈0", () => {
    const run = runNegative();
    expect(existsSync(NEGATIVE_PATH)).toBe(true);
    const md = readFileSync(NEGATIVE_PATH, "utf8");
    expect(run.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run.registered).toBe(REGISTERED);
    expect(md).toMatch(/\*\*Date:\*\*\s+\d{4}-\d{2}-\d{2}/);
    expect(md).toContain(`**Pre-registered:** ${REGISTERED}`);
    expect(md).toContain("openMemory");
    expect(md).toContain("hook-inject");
    expect(md).toContain("injectBody");
    expect(md).toContain("EDEN_MEMORY=0");
    expect(md).toMatch(/k:\*\* default/);
    expect(md).toContain("No k=40");
    expect(md).toContain("No hay");
    expect(md).toContain("LoCoMo 92");
    expect(md).toContain("Memorable 454/454");
    expect(md).toContain("Mem0 92");
    expect(md).toMatch(/fail by construction/i);
    expect(md).toContain("COMPETITORS V-zero");
    expect(md).toContain("0/0/5/5");
    expect(md).toContain("bun benchmarks/memory-holdout/run-negative.ts");
    expect(md).not.toMatch(/\|\s*BrainMemory\s*\|/);
    expect(md).toContain("| case | expect | baseline | probe |");
    expect(run.rows.map((r) => r.id)).toEqual([...REQUIRED_CASE_IDS]);
    for (const row of run.rows) {
      expect(honest(row), row.id).toBe(true);
      expect(md).toMatch(new RegExp(`\\| ${row.id} \\| ${row.expect} \\|`));
      expect(md).toContain(`| ${row.baseline.packet_bytes} | ${row.probe.packet_bytes} | ${row.delta_bytes} |`);
      expect(md).toContain(`| ${row.verdict} |`);
      if (row.verdict === "Δ≈0" && row.expect === "MEASURE") expect(row.seed_live).toBe(true);
    }
    expect(md).toContain("Seed liveness");
    expect(md).toContain("What sqlite database do we use?");
    if (run.rows.some((r) => r.expect === "MEASURE" && r.verdict === "Δ≈0")) {
      expect(run.seed_liveness.sqlite).toBe(true);
      expect(run.seed_liveness.packet_bytes).toBeGreaterThan(0);
    }
    const again = runNegative({ write: false });
    for (const row of run.rows) {
      const twin = again.rows.find((r) => r.id === row.id);
      expect(twin?.probe.packet_bytes).toBe(row.probe.packet_bytes);
      expect(twin?.baseline.packet_bytes).toBe(row.baseline.packet_bytes);
      expect(twin?.verdict).toBe(row.verdict);
      expect(twin?.leftover).toEqual(row.leftover);
    }
  });

  test("annex source does not import BrainMemory or set k=40", () => {
    const src = readFileSync(join(import.meta.dir, "run-negative.ts"), "utf8");
    expect(src).not.toMatch(/import\s*(?:type\s+)?(?:\{[^}]*\bBrainMemory\b[^}]*\}|\bBrainMemory\b)\s*from/);
    expect(src).not.toMatch(/EDEN_MEMORY_CAP\s*[:=]\s*["']?40/);
    expect(src).not.toMatch(/writeFileSync\([^)]*HELP\.md/);
    expect(existsSync(join(import.meta.dir, "HELP.md"))).toBe(false);
  });
});
