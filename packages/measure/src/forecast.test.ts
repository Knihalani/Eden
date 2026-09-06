import { describe, expect, test } from "bun:test";
import { forecastCopy, forecastHalt, remainingBudget, spend } from "./forecast";

describe("remainingBudget / forecastHalt", () => {
  test("prints the predicted vs actual triple and remaining", () => {
    const view = remainingBudget({
      predicted: { llmCalls: 2, ms: 80, cents: 8 },
      actual: { llmCalls: 2, ms: 40, cents: 3 },
      remainingTimeoutMs: 50_000,
    });
    console.log(
      `predicted llmCalls=${view.predicted.llmCalls} ms=${view.predicted.ms} cents=${view.predicted.cents} ` +
        `actual llmCalls=${view.actual.llmCalls} ms=${view.actual.ms} cents=${view.actual.cents} ` +
        `remaining llmCalls=${view.remaining.llmCalls} ms=${view.remaining.ms} cents=${view.remaining.cents} ` +
        `overflow=${view.overflow} halt=${view.halt}`,
    );
    expect(view.predicted).toEqual({ llmCalls: 2, ms: 80, cents: 8 });
    expect(view.actual).toEqual({ llmCalls: 2, ms: 40, cents: 3 });
    expect(view.remaining.llmCalls).toBe(0);
    expect(view.spent).toBe(true);
    expect(view.overflow).toBe("llmCalls");
    expect(view.halt).toBe(true);
    expect(forecastHalt({
      predicted: view.predicted,
      actual: view.actual,
      remainingTimeoutMs: view.remainingTimeoutMs,
    })).toBe(true);
    expect(forecastCopy(view)).toBe("predicted llmCalls=2 actual=2");
    console.log(`copy ${forecastCopy(view)}`);
  });

  test("forecastCopy names the overflowing dim, not a unique-work slur", () => {
    const llm = remainingBudget({
      predicted: { llmCalls: 2, ms: 80_000, cents: 8 },
      actual: { llmCalls: 2, ms: 10, cents: 0 },
      remainingTimeoutMs: 50_000,
    });
    const cents = remainingBudget({
      predicted: { llmCalls: 8, ms: 80_000, cents: 4 },
      actual: { llmCalls: 1, ms: 10, cents: 4 },
      remainingTimeoutMs: 50_000,
    });
    const timeout = remainingBudget({
      predicted: { llmCalls: 2, ms: 120_000, cents: 2 },
      actual: { llmCalls: 0, ms: 10_000, cents: 0 },
      remainingTimeoutMs: 30_000,
    });
    console.log(`copy llm=${forecastCopy(llm)} cents=${forecastCopy(cents)} timeout=${forecastCopy(timeout)}`);
    expect(forecastCopy(llm)).toBe("predicted llmCalls=2 actual=2");
    expect(forecastCopy(cents)).toBe("predicted cents=4 actual=4");
    expect(forecastCopy(timeout)).toBe("predicted ms=120000 remainingTimeoutMs=30000");
    expect(forecastCopy(llm).toLowerCase()).not.toMatch(/unique/);
  });

  test("actual llmCalls >= predicted llmCalls is a halt", () => {
    expect(
      remainingBudget({
        predicted: { llmCalls: 2, ms: 80_000, cents: 8 },
        actual: { llmCalls: 2, ms: 10, cents: 0 },
        remainingTimeoutMs: 50_000,
      }).halt,
    ).toBe(true);
  });

  test("actual ms >= predicted ms is a halt", () => {
    expect(
      remainingBudget({
        predicted: { llmCalls: 8, ms: 100, cents: 8 },
        actual: { llmCalls: 1, ms: 100, cents: 0 },
        remainingTimeoutMs: 50_000,
      }).overflow,
    ).toBe("ms");
  });

  test("actual cents >= predicted cents is a halt", () => {
    expect(
      remainingBudget({
        predicted: { llmCalls: 8, ms: 80_000, cents: 4 },
        actual: { llmCalls: 1, ms: 10, cents: 4 },
        remainingTimeoutMs: 50_000,
      }).overflow,
    ).toBe("cents");
  });

  test("predicted ms > remaining timeout is timeout pressure", () => {
    const view = remainingBudget({
      predicted: { llmCalls: 2, ms: 120_000, cents: 2 },
      actual: { llmCalls: 0, ms: 10_000, cents: 0 },
      remainingTimeoutMs: 30_000,
    });
    expect(view.spent).toBe(false);
    expect(view.timeoutPressure).toBe(true);
    expect(view.overflow).toBe("timeout");
    expect(view.halt).toBe(true);
  });

  test("a prediction that still fits remaining and is not spent does not halt", () => {
    const view = remainingBudget({
      predicted: { llmCalls: 4, ms: 5_000, cents: 8 },
      actual: { llmCalls: 1, ms: 2_000, cents: 1 },
      remainingTimeoutMs: 50_000,
    });
    expect(view.halt).toBe(false);
    expect(view.overflow).toBeNull();
    expect(forecastHalt({
      predicted: view.predicted,
      actual: view.actual,
      remainingTimeoutMs: view.remainingTimeoutMs,
    })).toBe(false);
  });

  test("zero predicted dimensions never halt (nothing to compare)", () => {
    expect(
      forecastHalt({
        predicted: { llmCalls: 0, ms: 0, cents: 0 },
        actual: { llmCalls: 9, ms: 9_000, cents: 9 },
        remainingTimeoutMs: 1,
      }),
    ).toBe(false);
  });

  test("negative remaining timeout is not timeout pressure (same gate as today)", () => {
    const view = remainingBudget({
      predicted: { llmCalls: 8, ms: 120_000, cents: 8 },
      actual: { llmCalls: 0, ms: 10, cents: 0 },
      remainingTimeoutMs: -50,
    });
    expect(view.timeoutPressure).toBe(false);
    expect(view.halt).toBe(false);
  });

  test("spend normalizes non-finite values", () => {
    expect(spend({ llmCalls: Number.NaN, ms: Number.POSITIVE_INFINITY, cents: undefined })).toEqual({
      llmCalls: 0,
      ms: 0,
      cents: 0,
    });
  });
});
