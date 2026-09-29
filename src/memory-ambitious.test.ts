/**
 * Ambitious retrieve A/B. Default path must stay green when EDEN_MEMORY_X is unset.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAmbitiousResults, runAmbitiousCases, runH1Ablation } from "../benchmarks/memory-ambitious/cases";
import { isMathChatterCue, memoryXOn } from "./index";

describe("memory-x flag is off by default", () => {
  test("unset EDEN_MEMORY_X is not on", () => {
    const prev = process.env.EDEN_MEMORY_X;
    delete process.env.EDEN_MEMORY_X;
    try {
      expect(memoryXOn()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_X;
      else process.env.EDEN_MEMORY_X = prev;
    }
  });

  test("isMathChatterCue", () => {
    expect(isMathChatterCue("what's 2+2?")).toBe(true);
    expect(isMathChatterCue("What is 17 times 23?")).toBe(true);
    expect(isMathChatterCue("thanks")).toBe(true);
    expect(isMathChatterCue("why is login broken?")).toBe(false);
    expect(isMathChatterCue("what database do we use")).toBe(false);
  });
});

describe("ambitious retrieve A/B", () => {
  test("aurora lifts needed-and-present without leaking math", async () => {
    const rows = await runAmbitiousCases();
    const md = renderAmbitiousResults(rows);
    const ab = await runH1Ablation();
    const abl = [
      "",
      "## H1 ablation (Auth is Clerk → why is login broken?)",
      "",
      "| flag | Clerk in packet | silent |",
      "|---|---|---|",
      ...ab.map((r) => `| ${r.flag} | ${r.hit ? "yes" : "no"} | ${r.silent} |`),
      "",
    ].join("\n");
    mkdirSync(join(import.meta.dir, "../benchmarks/memory-ambitious"), { recursive: true });
    writeFileSync(join(import.meta.dir, "../benchmarks/memory-ambitious/RESULTS.md"), md + abl);
    const need = rows.filter((r) => !r.wantSilent);
    const silence = rows.filter((r) => r.wantSilent);
    const defN = need.filter((r) => r.defaultHit).length;
    const aurN = need.filter((r) => r.auroraHit).length;
    expect(aurN).toBeGreaterThanOrEqual(defN);
    expect(silence.every((r) => r.auroraSilent)).toBe(true);
    expect(rows.find((r) => r.id === "H1-paraphrase-login-clerk")?.auroraHit).toBe(true);
  }, 30_000);
});
