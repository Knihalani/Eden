import { describe, expect, test } from "bun:test";
import { costScreen, costScreenLines } from "./cost-screen";

describe("costScreen (H18)", () => {
  const planted = [
    { variant: "hidden", readerCalls: 1, readerUsd: 0.0003, calls: 3, askMs: 10 },
    { variant: "hidden", readerCalls: 2, readerUsd: 0.0005, calls: 1, askMs: 30 },
    { variant: "control", readerCalls: 0, readerUsd: 0, calls: 2 },
  ];
  const neutral = [
    { readerCalls: 1, readerUsd: 0.0002, calls: 2 },
    { readerCalls: 2, readerUsd: 0.0004, calls: 4 },
  ];

  test("per kind: reader calls a task, $ per 1k as made, connector calls, ask ms", () => {
    const s = costScreen(planted, neutral);
    expect(s.kinds.hidden!.readerCallsPerTask).toBe(1.5);
    expect(s.kinds.hidden!.readerUsdPer1k).toBeCloseTo(0.4, 9);
    expect(s.kinds.hidden!.connectorCallsPerTask).toBe(2);
    expect(s.kinds.hidden!.askMsMean).toBe(20);
    expect(s.kinds.control!.askMsMean).toBeNull();
    expect(s.kinds.neutral!.readerUsdPer1k).toBeCloseTo(0.3, 9);
  });

  test("the mix is 0.1 hidden + 0.1 control + 0.8 neutral, and needs all three kinds", () => {
    const s = costScreen(planted, neutral);
    expect(s.mix!.readerCallsPerTask).toBeCloseTo(0.1 * 1.5 + 0.1 * 0 + 0.8 * 1.5, 9);
    expect(s.mix!.readerUsdPer1k).toBeCloseTo(0.1 * 0.4 + 0.8 * 0.3, 9);
    expect(costScreen(planted, []).mix).toBeNull();
  });

  test("rows without a model reader count as zero and are labelled; misses are said", () => {
    const s = costScreen([{ variant: "hidden", calls: 1 }], neutral);
    expect(s.kinds.hidden!.read).toBe(0);
    const lines = costScreenLines(s, 4).join("\n");
    expect(lines).toContain("1 rows without a model reader");
    expect(lines).toContain("needs hidden, control and neutral rows");
    expect(lines).toContain("4 reader prompts missed");
  });
});
