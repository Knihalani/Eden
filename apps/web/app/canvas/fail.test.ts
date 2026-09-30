import { describe, expect, test } from "bun:test";
import { classifyFail, emptyPanelCopy, failLabel, handoffContractLine, originLine, receiptPostmortem, REFRESH_WAITING_COPY, siblingStatus } from "./fail";
import { refusalCopy } from "@eden/ir";
import type { CanvasReceipt } from "./model";

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

  test("wrap timeout names the ceiling and does not replay completed writes", () => {
    const f = classifyFail({ lastOk: 0, reason: "timeout 120ms", outcome: "deopt" });
    expect(f?.kind).toBe("failed");
    expect(f?.detail).toMatch(/wrap timeout/i);
    expect(f?.next).toMatch(/will not replay/);
  });

  test("capacity receipt on a live tool (ok, degraded) still names fail-open", () => {
    const f = classifyFail({
      lastOk: 1,
      outcome: "degraded",
      reason: "capacity: session full (64/64), this stretch ran raw",
    });
    expect(f?.kind).toBe("degraded");
    expect(f?.detail).toMatch(/ran raw/);
    expect(f?.next).toMatch(/Other sessions were not dropped/);
  });

  test("timeout postmortem uses wrap timeout, not a shrug", () => {
    expect(receiptPostmortem({ outcome: "deopt", deoptReason: "timeout 120ms", stepsRun: 2, ms: 120 })).toMatch(
      /Wrap timeout/,
    );
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
    expect(receiptPostmortem({ outcome: "ok", timeSavedMs: -4, ms: 84 }, { budgetMs: 80, drift: true })).toContain(
      REFRESH_WAITING_COPY,
    );
    expect(receiptPostmortem({ outcome: "ok", timeSavedMs: -4, ms: 84 }, { budgetMs: 80 })).toMatch(/4ms over the tape/);
    expect(receiptPostmortem({ outcome: "ok", cache_lookups: 4, cache_hits: 3, ms: 12 })).toMatch(/3 of 4 reads from cache/);
    expect(receiptPostmortem({ outcome: "ok", cache_lookups: 0, cache_hits: 0, ms: 12 })).not.toMatch(/cache/);
    expect(receiptPostmortem({ outcome: "ok", ms: 12 })).not.toMatch(/cache/);
  });

  test("request origin uses the same failure words as the home list", () => {
    expect(originLine({ mode: "loop", firstWarningAt: 3 })).toBe("Compiled from a loop · warning at call 3");
    expect(originLine({ mode: "loop", firstWarningAt: 0 })).toBe("Compiled from a loop · warning at call 0");
    expect(originLine({ mode: "loop" })).toBe("Compiled from a loop");
    expect(originLine({ mode: "happy" })).toBeNull();
    expect(originLine(undefined)).toBeNull();
  });

  test("postmortem uses skipped vs degraded vs failed on the same drill-in", () => {
    expect(receiptPostmortem({ outcome: "skipped", skipped: ["check"], ms: 4 })).toMatch(/^Skipped/);
    expect(receiptPostmortem({ outcome: "degraded", ms: 4 })).toMatch(/^Degraded/);
    expect(receiptPostmortem({ outcome: "failed", ms: 4 })).toMatch(/^Failed/);
    expect(receiptPostmortem({ ok: 0, ms: 4 })).toMatch(/^Failed/);
    expect(receiptPostmortem({ outcome: "ok", tokensSaved: null, ms: 4 })).not.toMatch(/tokens saved/);
    expect(receiptPostmortem({ outcome: "ok", tokensSaved: 0, ms: 4 })).not.toMatch(/tokens saved/);
  });

  test("canvas empty graph uses named class, counts, and what to change", () => {
    const copy = refusalCopy({
      reason: "readFile repeats 6x without a bindable foreach",
      code: "read_set_mismatch",
      readSet: 12,
      repeats: 6,
      hint: "grepCode returned 12; readFile ran 6 times. Expose the full array the loop iterates, or iterate once per item.",
    });
    expect(copy).toMatch(/^Read-set mismatch\./);
    expect(copy).toMatch(/12/);
    expect(copy).toMatch(/6 times/);
    expect(copy).toMatch(/Expose the full array/);
  });

  test("sibling strip uses the Needs attention short label, not the raw compiler string", () => {
    expect(
      siblingStatus({
        verdict: "FAIL",
        reason: "readFile repeats 6x without a bindable foreach",
        code: "read_set_mismatch",
        readSet: 12,
        repeats: 6,
      }),
    ).toBe("Read-set · 6 of 12");
    expect(siblingStatus({ verdict: "FAIL", reason: "writeRecord arguments are under-determined" })).toBe("Unbound write");
    expect(siblingStatus({ verdict: "PASS" })).toBe("Ready");
    expect(siblingStatus({ verdict: "FAIL", reason: "weak" })).toBe("Refused");
  });

  test("refused empty graph puts the same diagnosis in the side panel", () => {
    const copy = refusalCopy({
      reason: "readFile repeats 6x without a bindable foreach",
      code: "read_set_mismatch",
      readSet: 12,
      repeats: 6,
      hint: "grepCode returned 12; readFile ran 6 times. Expose the full array the loop iterates, or iterate once per item.",
    });
    expect(emptyPanelCopy({ program: null, refusal: copy })).toBe(copy);
    expect(emptyPanelCopy({ program: { id: "p" }, refusal: copy })).toBe(
      "Select a step to inspect bindings, reads, and writes.",
    );
    expect(emptyPanelCopy({ program: null })).toBe("Select a step to inspect bindings, reads, and writes.");
  });

  test("remainder skip names the program and does not invent skip counts", () => {
    const f = classifyFail({
      reason: "Already served by pr_summary. Do not re-run Grep — the remaining steps of this routine are in the last tool output.",
    });
    expect(f?.kind).toBe("skipped");
    expect(f?.step).toBe("Grep");
    expect(f?.detail).toMatch(/pr_summary/);
    expect(f?.detail).toMatch(/already served/i);
    expect(f?.next).toMatch(/do not re-run/i);
    expect(f?.next).toMatch(/facts are in the last tool output or attached as context/i);
    expect(`${f?.detail} ${f?.next}`).not.toMatch(/\d+ skip/);
    expect(failLabel(f!.kind)).toBe("Skipped");
  });

  test("host-dropped rewrite is degraded; facts still attached as context", () => {
    const f = classifyFail({
      reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
    });
    expect(f?.kind).toBe("degraded");
    expect(f?.detail).toMatch(/kept the original tool output/i);
    expect(f?.detail).toMatch(/context/i);
    expect(f?.next).toMatch(/context/i);
    expect(f?.next).toMatch(/remainder deny/i);
    expect(f?.step).toBeUndefined();
    expect(failLabel(f!.kind)).toBe("Degraded");
  });

  test("the live host-drop receipt (ok + skipped + drop reason) stays degraded, not remainder skip", () => {
    const f = classifyFail({
      lastOk: 1,
      skipped: ["Read"],
      reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
    });
    expect(f?.kind).toBe("degraded");
    expect(f?.detail).toMatch(/kept the original tool output/i);
    expect(f?.step).toBeUndefined();
  });

  test("remainder skip from skipped tails does not need the deny sentence on reason", () => {
    const f = classifyFail({
      lastOk: 1,
      skipped: ["Grep"],
      programName: "pr_summary",
    });
    expect(f?.kind).toBe("skipped");
    expect(f?.step).toBe("Grep");
    expect(f?.detail).toMatch(/pr_summary/);
    expect(f?.detail).toMatch(/already served/i);
    expect(f?.next).toMatch(/facts are in the last tool output or attached as context/i);
  });

  test("steered-skip token class uses the same remainder copy as Home's Skipped word", () => {
    const f = classifyFail({ tokenClass: "steered-skip", programName: "pr_summary", skipped: ["Bash"] });
    expect(f?.kind).toBe("skipped");
    expect(failLabel(f!.kind)).toBe("Skipped");
    expect(f?.detail).toMatch(/pr_summary/);
  });

  test("refresh-waiting uses the same words as the draft row a person Approves", () => {
    const f = classifyFail({ drift: true, lastOk: 0, reason: "deopt on step get_status" });
    expect(f?.kind).toBe("degraded");
    expect(`${f?.detail} ${f?.next}`).toBe(REFRESH_WAITING_COPY);
    expect(failLabel(f!.kind)).toBe("Degraded");
    const named = classifyFail({ reason: "The outside world renamed a field. A replacement is waiting." });
    expect(`${named?.detail} ${named?.next}`).toBe(REFRESH_WAITING_COPY);
  });

  test("shared across N agents uses the same ledger words as Home", () => {
    const f = classifyFail({ sharedAcross: 2, lastOk: 1 });
    expect(f?.kind).toBe("skipped");
    expect(f?.detail).toBe("shared across 2 agents");
    expect(failLabel(f!.kind)).toBe("Skipped");
    expect(classifyFail({ reason: "shared across 3 agents" })?.detail).toBe("shared across 3 agents");
    expect(receiptPostmortem({ outcome: "ok", sharedAcross: 2, ms: 4 })).toContain("shared across 2 agents");
  });

  test("postmortem names the whole stretch so a drop is not hidden behind a later skip", () => {
    const words = ["Served", "Skipped", "Degraded"] as const;
    const rec: CanvasReceipt = { outcome: "ok", tokenClass: "steered-skip", skipped: ["Grep"], ms: 4 };
    const line = receiptPostmortem(rec, { stretchWords: [...words] });
    expect(line).toMatch(/dropped the rewrite/i);
    expect(line).toMatch(/tails skipped/i);
    expect(line).not.toBe("Ok · skipped Grep · 4ms this run");
  });

  test("handoff origin uses the same word as Home", () => {
    expect(originLine({ mode: "handoff" })).toBe("Compiled from a handoff");
  });

  test("compose origin uses the same word as Home", () => {
    expect(originLine({ mode: "compose" })).toBe("Compiled from a compose");
  });

  test("handoff contract names children and stays off until Approve", () => {
    expect(handoffContractLine(null)).toBeNull();
    expect(handoffContractLine({ sequence: ["lookup"] })).toBeNull();
    expect(
      handoffContractLine({
        composedOf: ["p_a", "p_b"],
        sequence: ["lookupTicket_to_classifyIssue", "fetchInvoice_to_applyCredit"],
      }),
    ).toBe(
      "Handoff of lookupTicket_to_classifyIssue → fetchInvoice_to_applyCredit. Live tool unchanged until you Approve.",
    );
  });

  test("compose contract uses Compose, not Handoff", () => {
    expect(
      handoffContractLine(
        {
          composedOf: ["p_a", "p_b"],
          sequence: ["lookupTicket_to_notify", "fetchInvoice_to_applyCredit"],
        },
        "compose",
      ),
    ).toBe(
      "Compose of lookupTicket_to_notify → fetchInvoice_to_applyCredit. Live tool unchanged until you Approve.",
    );
  });
});
