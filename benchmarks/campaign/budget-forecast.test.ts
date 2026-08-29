/**
 * Wave 15.1 CI pin: predicted vs actual llm/ms/cents; unique-work halt=0.
 * Observe never forecast-halts. Not a retune of unique-work cents / campaign worlds.
 *
 *   bun test benchmarks/campaign/budget-forecast.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  EXPECT,
  PREDICTED,
  enforceOverBudget,
  forecastCopy,
  killAfterWarningDecision,
  observeOverBudget,
  predictedVsActualPrint,
  timeoutPressureHalt,
  uniqueWorkHaltCount,
  uniqueWorkUnwarnedHaltCount,
  unwarnedOverBudget,
  unwarnedHeadOverBudget,
} from "./budget-forecast";

describe("rotation: budget-forecast (Wave 15.1)", () => {
  test("pre-registered expect is predicted-vs-actual, not a unique-work slur", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("predicted vs actual");
    expect(EXPECT).toContain("unique-work halt count 0");
    expect(EXPECT.toLowerCase()).not.toMatch(/unique so we stopped|halted for being unique/);
  });

  test("unique-work halt count 0 under enforce + huge unrelated live budget", async () => {
    const probe = await uniqueWorkHaltCount({ enforce: true });
    console.log(`unique-work budget_halt=${probe.budgetHalts} calls=${probe.calls} reasons=${probe.reasons.join(",") || "none"}`);
    expect(probe.calls).toBe(4);
    expect(probe.budgetHalts).toBe(0);
  });

  test("enforce: actual llmCalls >= predicted → halt reason budget; observe does not", async () => {
    const view = predictedVsActualPrint();
    console.log(
      `predicted llmCalls=${view.predicted.llmCalls} ms=${view.predicted.ms} cents=${view.predicted.cents} ` +
        `actual llmCalls=${view.actual.llmCalls} ms=${view.actual.ms} cents=${view.actual.cents} ` +
        `overflow=${view.overflow} halt=${view.halt}`,
    );
    expect(view.predicted).toEqual({ llmCalls: PREDICTED.llmCalls, ms: PREDICTED.ms, cents: PREDICTED.cents });
    expect(view.actual.llmCalls).toBeGreaterThanOrEqual(view.predicted.llmCalls);
    expect(view.halt).toBe(true);

    const enforced = await enforceOverBudget();
    console.log(
      `enforce halted=${enforced.halted} reason=${enforced.reason} ` +
        `predicted_llm=${enforced.predicted.llmCalls} actual_llm=${enforced.actual.llmCalls}`,
    );
    expect(enforced.halted).toBe(true);
    expect(enforced.reason).toBe("budget");
    expect(enforced.actual.llmCalls).toBeGreaterThanOrEqual(enforced.predicted.llmCalls);

    const observed = await observeOverBudget();
    console.log(`observe halted=${observed.halted} served=${observed.served}`);
    expect(observed.halted).toBe(false);
    expect(observed.served).toBe(true);
  });

  test("unwarned over-budget: firstWarningAt unset, enforce halt, observe served, unique-work 0", async () => {
    const view = predictedVsActualPrint();
    console.log(`unwarned copy=${forecastCopy(view)}`);
    const enforced = await unwarnedOverBudget({ enforce: true });
    console.log(
      `unwarned enforce halted=${enforced.halted} reason=${enforced.reason} ` +
        `detail=${enforced.detail} firstWarningAt=${enforced.firstWarningAt ?? "undefined"} ` +
        `predicted llmCalls=${enforced.predicted.llmCalls} actual=${enforced.actualLlm}`,
    );
    expect(enforced.firstWarningAt).toBeUndefined();
    expect(enforced.halted).toBe(true);
    expect(enforced.reason).toBe("budget");
    expect(enforced.detail).toBe("predicted llmCalls=2 actual=2");
    expect(enforced.actualLlm).toBeGreaterThanOrEqual(enforced.predicted.llmCalls);

    const observed = await unwarnedOverBudget({ enforce: false });
    console.log(`unwarned observe halted=${observed.halted} served=${observed.served} detail=${observed.detail}`);
    expect(observed.halted).toBe(false);
    expect(observed.served).toBe(true);
    expect(observed.detail).toBe("predicted llmCalls=2 actual=2");

    const unique = await uniqueWorkUnwarnedHaltCount();
    console.log(`unwarned unique-work budget_halt=${unique.budgetHalts} calls=${unique.calls}`);
    expect(unique.budgetHalts).toBe(0);

    expect(view.halt).toBe(true);
  });

  test("sequence-head spent halt: enforce halt+detail, observe compiles (not list_comments)", async () => {
    const enforced = await unwarnedHeadOverBudget({ enforce: true });
    console.log(
      `head enforce halted=${enforced.halted} reason=${enforced.reason} detail=${enforced.detail ?? ""} ` +
        `notified=${enforced.notified} keys=${enforced.keys.join(",")} steps=${enforced.steps} ` +
        `firstWarningAt=${enforced.firstWarningAt ?? "undefined"}`,
    );
    expect(enforced.steps).toBe(3);
    expect(enforced.firstWarningAt).toBeUndefined();
    expect(enforced.halted).toBe(true);
    expect(enforced.reason).toBe("budget");
    expect(enforced.detail).toBe("predicted llmCalls=2 actual=2");
    expect(enforced.notified).toBe(false);
    expect(enforced.keys).toEqual(["detail", "eden", "reason"]);

    const observed = await unwarnedHeadOverBudget({ enforce: false });
    console.log(
      `head observe halted=${observed.halted} served=${observed.served} notified=${observed.notified} ` +
        `keys=${observed.keys.join(",")}`,
    );
    expect(observed.halted).toBe(false);
    expect(observed.served).toBe(true);
    expect(observed.notified).toBe(true);
    expect(observed.keys).not.toContain("eden");
  });

  test("predicted ms > remaining timeout still halts for the matching program", () => {
    const d = timeoutPressureHalt();
    console.log(`timeout-pressure action=${d.action} reason=${d.reason}`);
    expect(d.action).toBe("halt");
    expect(d.reason).toBe("budget");
  });

  test("EDEN_KILL_AFTER_WARNING still wins when predicted budget would fit", () => {
    const d = killAfterWarningDecision();
    console.log(`killAfterWarning reason=${d.reason} budgetWouldHalt=${d.budgetWouldHalt}`);
    expect(d.budgetWouldHalt).toBe(false);
    expect(d.reason).toBe("warning");
  });
});
