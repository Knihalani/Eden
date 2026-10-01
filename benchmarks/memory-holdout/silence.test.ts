/**
 * M38.3 remain-silent holdout. Dated 2026-09-24.
 * Asserts SILENCE.md shape: Δ≈0, omitted, dated. Does not retune the ranker.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_PATH,
  REQUIRED_CASE_IDS,
  loadSilenceFixture,
  runSilence,
  silenceFixtureIssues,
  withinBand,
  type SilenceRow,
} from "./run-silence.ts";

const REGISTERED = "2026-09-24";

// The report renders here, not over the tracked SILENCE.md (only the CLI rewrites that).
const REPORT_DIR = mkdtempSync(join(tmpdir(), "eden-silence-"));
const REPORT = join(REPORT_DIR, "SILENCE.md");
afterAll(() => rmSync(REPORT_DIR, { recursive: true, force: true }));

function honest(row: SilenceRow): boolean {
  if (row.verdict === "WIN") {
    const onOk = row.omitted_on === null ? row.baseline.omitted && row.probe.omitted : row.omitted_on === true;
    return (
      row.delta_approx_0 &&
      row.delta_bytes === 0 &&
      row.body_delta_bytes === 0 &&
      row.leftover.length === 0 &&
      row.body_leftover.length === 0 &&
      onOk &&
      row.baseline.omitted &&
      row.probe.omitted &&
      row.baseline.body_omitted &&
      row.probe.body_omitted &&
      row.baseline.packet_bytes === 0 &&
      row.probe.packet_bytes === 0
    );
  }
  if (row.verdict === "LOSS") {
    return (
      row.leftover.length > 0 ||
      row.body_leftover.length > 0 ||
      !row.delta_approx_0 ||
      row.omitted_on === false ||
      !row.probe.omitted ||
      !row.baseline.omitted
    );
  }
  return row.verdict === "FAIL";
}

describe("M38.3 silence holdout", () => {
  test("fixture pre-registers OMIT before the measured verdict (2026-09-24)", () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    const fix = loadSilenceFixture();
    expect(silenceFixtureIssues(fix)).toEqual([]);
    expect(fix.dated_registered).toBe(REGISTERED);
    expect(fix.api_under_test).toBe("openMemory.inject");
    expect(fix.k).toBe("default");
    expect(fix.k_default).toBe(6);
    expect(fix.materiality).toBe(0.01);
    expect(fix.backbone).toBe("N/A");
    expect(fix.product).toEqual(["openMemory", "inject", "injectBody"]);
    expect(fix.named_not_scored).toEqual(["hook-inject"]);
    for (const id of REQUIRED_CASE_IDS) expect(fix.cases.find((c) => c.id === id)?.expect).toBe("OMIT");
    expect(fix.cases.find((c) => c.id === "seeded-times")?.cue).toBe("What is 17 times 23?");
    expect(fix.seed_liveness.cue).toBe("What sqlite database do we use?");
    expect(fix.seed_liveness.needle).toBe("sqlite");
    expect(withinBand(0, 0)).toBe(true);
    expect(withinBand(0, 1)).toBe(false);
  });

  test("SILENCE.md is dated, Δ≈0 when WIN, and names omit", () => {
    const run = runSilence({ out: REPORT });
    expect(existsSync(REPORT)).toBe(true);
    const md = readFileSync(REPORT, "utf8");
    expect(run.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run.registered).toBe(REGISTERED);
    expect(md).toMatch(/\*\*Date:\*\*\s+\d{4}-\d{2}-\d{2}/);
    expect(md).toContain(`**Pre-registered:** ${REGISTERED}`);
    expect(md).toContain("**Date:**");
    expect(md).toContain("openMemory");
    expect(md).toContain("injectBody");
    expect(md).toContain("hook-inject");
    expect(md).toContain("EDEN_MEMORY=0");
    expect(md).toContain("EDEN_KNOW=0");
    expect(md).toMatch(/k:\*\* default/);
    expect(md).toContain("**Backbone:** N/A (no LLM reader)");
    expect(md).toContain("Remain-silent is compatible with fail-open; Start briefing is M38.2/M7.3 not this annex.");
    expect(md).toContain("| case | omitted on-arm | packet B off | packet B on | Δ B | leftover | verdict |");
    expect(md).not.toMatch(/\|\s*BrainMemory\s*\|/);
    expect(md).toContain("bun benchmarks/memory-holdout/run-silence.ts");
    expect(run.rows.map((r) => r.id)).toEqual([...REQUIRED_CASE_IDS]);
    for (const row of run.rows) {
      expect(honest(row), `${row.id} ${row.verdict} ${row.note}`).toBe(true);
      expect(md).toContain(`| ${row.id} |`);
      expect(md).toContain(`| ${row.verdict} |`);
      if (row.verdict === "WIN") {
        expect(row.delta_bytes).toBe(0);
        expect(md).toContain(`| ${row.id} | ${row.omitted_on === null ? "n/a" : "yes"} |`);
      }
      if (row.verdict === "LOSS" && row.leftover.length) {
        expect(row.note).toMatch(/LOSS leftover/);
        expect(md).toContain(row.leftover[0]!);
      }
    }
    const silence = run.rows.filter((r) => r.id !== "aa-off");
    for (const row of silence) {
      if (row.verdict === "WIN") expect(row.omitted_on).toBe(true);
    }
    if (run.rows.some((r) => r.store_n > 0 && r.verdict === "WIN")) {
      expect(run.seed_liveness.sqlite).toBe(true);
      expect(run.seed_liveness.packet_bytes).toBeGreaterThan(0);
    }
    expect(md).toContain("Seed liveness");
    expect(md).toContain("What sqlite database do we use?");
  });

  test("annex source does not import BrainMemory or set k=40", () => {
    const src = readFileSync(join(import.meta.dir, "run-silence.ts"), "utf8");
    expect(src).not.toMatch(/import\s*(?:type\s+)?(?:\{[^}]*\bBrainMemory\b[^}]*\}|\bBrainMemory\b)\s*from/);
    expect(src).not.toMatch(/EDEN_MEMORY_CAP\s*[:=]\s*["']?40/);
    expect(src).toContain("SILENCE_PATH");
    expect(src).not.toMatch(/writeFileSync\(\s*NEGATIVE_PATH\b/);
  });
});
