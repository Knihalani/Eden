/**
 * Wave 5.2 — Redteam / evals / offline experiments:
 * start-run honesty, status polling, no false success, ErrorState over false empty.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interpretOfflineRunResult,
  interpretRedteamScan,
  isTerminalExperimentStatus,
  shouldPollExperimentStatus,
} from "@/lib/eval-run-outcome";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5-2 interpretRedteamScan", () => {
  it("does not treat empty runs as success", () => {
    expect(interpretRedteamScan({ runs: [] }).kind).toBe("empty");
    expect(
      interpretRedteamScan({
        runs: [{ prompts_executed: 0, failure_count: 0 }],
      }).kind,
    ).toBe("empty");
  });

  it("reports findings without calling them scan failures", () => {
    const out = interpretRedteamScan({
      runs: [{ prompts_executed: 3, failure_count: 2 }],
    });
    expect(out).toEqual({ kind: "findings", findingCount: 2 });
  });

  it("success only when probes executed and no findings", () => {
    expect(
      interpretRedteamScan({
        runs: [{ prompts_executed: 2, failure_count: 0 }],
      }),
    ).toEqual({ kind: "success", findingCount: 0 });
  });
});

describe("W5-2 interpretOfflineRunResult", () => {
  it("never treats missing status as completed", () => {
    expect(interpretOfflineRunResult(undefined).kind).toBe("invalid");
    expect(interpretOfflineRunResult({}).kind).toBe("invalid");
    expect(interpretOfflineRunResult({ status: "completed" }).kind).toBe(
      "completed",
    );
  });

  it("flags synthetic completion honestly", () => {
    const out = interpretOfflineRunResult({
      status: "completed",
      synthetic: true,
      method: "heuristic_stub",
    });
    expect(out.kind).toBe("completed");
    expect(out.message).toMatch(/not a live model eval/i);
  });

  it("routes pending/running to in_progress for status polling", () => {
    expect(interpretOfflineRunResult({ status: "pending" }).kind).toBe(
      "in_progress",
    );
    expect(interpretOfflineRunResult({ status: "running" }).kind).toBe(
      "in_progress",
    );
    expect(interpretOfflineRunResult({ status: "failed" }).kind).toBe(
      "failed",
    );
  });

  it("terminal vs poll helpers", () => {
    expect(isTerminalExperimentStatus("completed")).toBe(true);
    expect(isTerminalExperimentStatus("failed")).toBe(true);
    expect(isTerminalExperimentStatus("running")).toBe(false);
    expect(shouldPollExperimentStatus("running")).toBe(true);
    expect(shouldPollExperimentStatus("pending")).toBe(true);
    expect(shouldPollExperimentStatus("completed")).toBe(false);
  });
});

describe("W5-2 redteam page wiring", () => {
  it("uses interpretRedteamScan + ErrorState for start-run failures", () => {
    const src = read("app/(portal)/redteam/page.tsx");
    expect(src).toContain("interpretRedteamScan");
    expect(src).toContain("Could not start scan");
    expect(src).toContain("scanError");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).not.toMatch(/toast\.success\(["']Scan complete["']\s*\)\s*;/);
    expect(src).not.toContain("Scan completed with failures");
  });

  it("gates findings empty behind QueryState", () => {
    const src = read("app/(portal)/redteam/page.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain("<QueryState");
    expect(src).toContain("Could not load findings");
  });
});

describe("W5-2 experiments offline wiring", () => {
  it("checks run result status and polls until terminal", () => {
    const hook = read("app/(portal)/experiments/_components/use-experiments-page.ts");
    const list = read("app/(portal)/experiments/_components/experiments-list.tsx");
    expect(hook).toContain("interpretOfflineRunResult");
    expect(hook).toContain("pollUntilTerminal");
    expect(hook).toContain("runningId");
    expect(list).toContain("Could not start run");
    expect(list).toContain("runError");
    expect(hook).not.toMatch(
      /await offlineExperimentsApi\.run\([\s\S]{0,80}toast\.success\(["']Experiment completed["']\)/,
    );
  });

  it("keeps list/compare ErrorState (no false empty on outage)", () => {
    const list = read("app/(portal)/experiments/_components/experiments-list.tsx");
    const panel = read("app/(portal)/experiments/_components/compare-panel.tsx");
    expect(list).toContain("Could not load experiments");
    expect(panel).toContain("Could not load compare");
    expect(list).toMatch(/loadError && !loading/);
  });
});

describe("W5-2 evals hub embeds experiments", () => {
  it("experiments tab loads offline experiments surface", () => {
    const src = read("app/(portal)/evals/page.tsx");
    expect(src).toContain('TabsContent value="experiments"');
    expect(src).toContain("ExperimentsView");
  });
});
