/**
 * goLive shape-family split: a 3-arm fork is one family, not three thin
 * linear shapes. FAIL loudly — never skip-as-win.
 */
import { describe, expect, test } from "bun:test";
import { blockSeed } from "./worlds";
import { Session } from "./session";
import { SEV_ALERTS, createSevTriage } from "./horizon-extra-worlds";

process.env.CAMPAIGN_THINK_MS = "0";

describe("session.goLive fork family", () => {
  test("3 equal arms × 4 traces = 12 clean is enough to not SKIP for dominant-shape", async () => {
    const goals = [...SEV_ALERTS].map((alert) => ({ alert }));
    const s = new Session([["sev-triage", createSevTriage]], true);
    for (let i = 0; i < 12; i++) {
      await s.stretch("sev-triage", goals[i % goals.length]!, blockSeed(`fork-family-12-${i}`, i));
    }
    const r = await s.goLive("sev-triage", {
      compile: 9,
      holdout: 3,
      sandbox: createSevTriage,
      maxGram: 26,
    });
    const dominantSkip = r.reasons.some((x) => /^dominant shape has only \d+ clean traces$/.test(x));
    expect(dominantSkip, `dominant-shape SKIP at 12 traces: ${r.reasons.join("; ")}`).toBe(false);
    expect(r.verdict, `sev-triage@12 goLive ${r.verdict}: ${r.reasons.join("; ")} — not a skip-as-win`).toBe("PASS");
    expect(r.program).not.toBeNull();
    const brs = r.program!.steps.filter((s) => s.kind === "branch");
    expect(
      brs.length,
      `want a branched program, steps=${r.program!.steps.map((s) => s.kind).join(",")}`,
    ).toBeGreaterThanOrEqual(1);
    const nway = brs.length >= 2 || (brs[0]!.kind === "branch" && (brs[0].cases?.length ?? 0) >= 1);
    expect(nway, "3-arm fork must be nested branches or one branch with cases").toBe(true);
  }, 60_000);
});
