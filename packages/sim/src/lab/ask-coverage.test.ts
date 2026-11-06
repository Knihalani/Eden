import { describe, expect, test } from "bun:test";
import { coverageBucket, coverageLines, coverageSplit, type AskCoverage } from "./ask-coverage";

const base: AskCoverage = { cardRead: true, leanSkipped: false, replayRequests: 2, heldRequests: 2, intent: null };

describe("coverageBucket", () => {
  test("an item the ask ranked is not a gap", () => {
    expect(coverageBucket({ rank: 3, cached: true, coverage: base })).toBeNull();
  });
  test("an uncached item is its own bucket, before any coverage", () => {
    expect(coverageBucket({ rank: -1, cached: false, coverage: { ...base, leanSkipped: true } })).toBe("not cached");
  });
  test("lean-skipped wins over no requests (it holds none because it was not read)", () => {
    const c = { ...base, cardRead: false, leanSkipped: true, heldRequests: 0 };
    expect(coverageBucket({ rank: -1, cached: true, coverage: c })).toBe("lean-skipped");
  });
  test("read but no requests held", () => {
    const c = { ...base, heldRequests: 0, replayRequests: null };
    expect(coverageBucket({ rank: -1, cached: true, coverage: c })).toBe("no intent requests");
  });
  test("requests held, split by how the bridge failed", () => {
    expect(coverageBucket({ rank: -1, cached: true, coverage: base })).toBe("no shared term");
    const under = { ...base, intent: { coverage: 0.2, matched: 1, passes: false, rank: -1 } };
    expect(coverageBucket({ rank: -1, cached: true, coverage: under })).toBe("under thresholds");
    const over = { ...base, intent: { coverage: 0.6, matched: 3, passes: true, rank: 9 } };
    expect(coverageBucket({ rank: -1, cached: true, coverage: over })).toBe("over thresholds");
  });
  test("no coverage facts (cards or intent off): counted as no requests", () => {
    expect(coverageBucket({ rank: -1, cached: true })).toBe("no intent requests");
  });
});

describe("coverageSplit and coverageLines", () => {
  const rows = [
    {
      variant: "hidden",
      rank: -1,
      cached: true,
      coverage: { ...base, cardRead: false, leanSkipped: true, heldRequests: 0 },
    },
    { variant: "hidden", rank: -1, cached: true, coverage: { ...base, heldRequests: 0 } },
    { variant: "hidden", rank: -1, cached: true, coverage: base },
    { variant: "hidden", rank: -1, cached: true, coverage: base },
    { variant: "hidden", rank: 0, cached: true, coverage: base },
    { variant: "control", rank: -1, cached: true, coverage: base },
  ];
  test("the three top-level buckets sum to the rank -1 count, per variant", () => {
    const s = coverageSplit(rows, "hidden");
    expect(s.unranked).toBe(4);
    expect(s.leanSkipped + s.noRequests + s.noMatch + s.notCached).toBe(s.unranked);
    expect(s).toMatchObject({ leanSkipped: 1, noRequests: 1, noMatch: 2, noSharedTerm: 2, under: 0, over: 0 });
    expect(coverageSplit(rows, "control").unranked).toBe(1);
  });
  test("the summary names each bucket and leaves out an empty not-cached one", () => {
    const [h, d] = coverageLines(rows);
    expect(h).toBe(
      "ask-diag: hidden rank -1 4/5: lean-skipped 1, no intent requests 1, requests but no match 2 " +
        "(no shared term 2, under thresholds 0, over thresholds 0)",
    );
    expect(d).toStartWith("ask-diag: decoy rank -1 1/1: ");
    expect(coverageLines([])).toEqual([]);
  });
});
