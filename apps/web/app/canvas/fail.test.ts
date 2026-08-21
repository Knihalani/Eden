import { describe, expect, test } from "bun:test";
import { classifyFail, failLabel, receiptPostmortem } from "./fail";

describe("canvas fail language", () => {
  test("missing path is blocked, not invented", () => {
    const f = classifyFail({
      faults: [{ field: "write.id", message: "Missing path." }],
    });
    expect(f?.kind).toBe("blocked");
    expect(f?.step).toBe("write");
    expect(f?.detail).toMatch(/Nothing is invented/);
    expect(failLabel(f!.kind)).toBe("Blocked");
  });

  test("skip rate is skipped", () => {
    const f = classifyFail({ skipRateAfter: 0.2 });
    expect(f?.kind).toBe("skipped");
    expect(failLabel("skipped")).toBe("Skipped");
  });

  test("inconclusive is degraded", () => {
    const f = classifyFail({ verdict: "INCONCLUSIVE", reason: "not measured — quality held but neither tokens nor time saved" });
    expect(f?.kind).toBe("degraded");
    expect(failLabel("degraded")).toBe("Degraded");
  });

  test("receipt miss is failed with a next action", () => {
    const f = classifyFail({ lastOk: 0, reason: "deopt on step write" });
    expect(f?.kind).toBe("failed");
    expect(f?.step).toBe("write");
    expect(f?.next).toMatch(/Resume/);
    expect(failLabel("failed")).toBe("Failed");
  });

  test("early deopt is named on the same drill-in", () => {
    const f = classifyFail({ lastOk: 0, reason: "deopt: input not in witness envelope", early: true });
    expect(f?.detail).toMatch(/Early/);
  });

  test("pass with no faults is silent", () => {
    expect(classifyFail({ verdict: "PASS", skipRateAfter: 0, lastOk: 1 })).toBeNull();
  });

  test("live postmortem confirms this run against the tape, not the estimate", () => {
    expect(
      receiptPostmortem(
        { outcome: "ok", stepsRun: 4, timeSavedMs: 68, ms: 12 },
        { budgetMs: 80 },
      ),
    ).toBe("Ok · 4 steps · 68ms saved this run · 12ms this run · budget 80ms");
    expect(receiptPostmortem({ outcome: "deopt", early: true, deoptReason: "deopt: input not in witness envelope", ms: 0 })).toBe(
      "Fell back · early · input not in witness envelope · 0ms this run",
    );
    expect(receiptPostmortem({ outcome: "ok", timeSavedMs: -4, ms: 84 }, { budgetMs: 80, drift: true })).toMatch(
      /fingerprint moved/,
    );
    expect(receiptPostmortem({ outcome: "ok", timeSavedMs: -4, ms: 84 }, { budgetMs: 80 })).toMatch(/4ms over the tape/);
  });
});
