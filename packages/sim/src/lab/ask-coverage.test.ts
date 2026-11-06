import { describe, expect, test } from "bun:test";
import { coverageBucket, coverageLines, coverageSplit, intentPlace, type AskCoverage } from "./ask-coverage";

const base: AskCoverage = {
  cardRead: true,
  notSentPrefilterRejects: false,
  replayRequests: 2,
  heldRequests: 2,
  intent: null,
};

describe("coverageBucket", () => {
  test("an item the ask ranked is not a gap", () => {
    expect(coverageBucket({ rank: 3, cached: true, coverage: base })).toBeNull();
  });
  test("an uncached item is its own bucket, before any coverage", () => {
    expect(coverageBucket({ rank: -1, cached: false, coverage: { ...base, notSentPrefilterRejects: true } })).toBe(
      "not cached",
    );
  });
  test("not sent and prefilter-rejected wins over no requests (it holds none because it was not read)", () => {
    const c = { ...base, cardRead: false, notSentPrefilterRejects: true, heldRequests: 0 };
    expect(coverageBucket({ rank: -1, cached: true, coverage: c })).toBe("not sent, prefilter rejects");
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
      coverage: { ...base, cardRead: false, notSentPrefilterRejects: true, heldRequests: 0 },
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
    expect(s.notSentPrefilterRejects + s.noRequests + s.noMatch + s.notCached).toBe(s.unranked);
    expect(s).toMatchObject({
      notSentPrefilterRejects: 1,
      noRequests: 1,
      noMatch: 2,
      noSharedTerm: 2,
      under: 0,
      over: 0,
    });
    expect(coverageSplit(rows, "control").unranked).toBe(1);
  });
  test("the summary names each bucket and leaves out an empty not-cached one", () => {
    const [h, d] = coverageLines(rows);
    expect(h).toBe(
      "ask-diag: hidden rank -1 4/5: not sent, prefilter rejects 1, no intent requests 1, requests but no match 2 " +
        "(no shared term 2, under thresholds 0, over thresholds 0)",
    );
    expect(d).toStartWith("ask-diag: decoy rank -1 1/1: ");
    expect(coverageLines([])).toEqual([]);
  });
});

describe("intentPlace (partner.ts intentFinds' cut, applied lab-side)", () => {
  const hit = (matched: number, coverage: number) => ({ matched, coverage });
  test("no hit holds the item: null", () => {
    expect(intentPlace([], "x", 2, 0.35)).toBeNull();
    expect(intentPlace([{ ids: ["a"], hit: hit(3, 0.9) }], "x", 2, 0.35)).toBeNull();
  });
  test("passing hits before the item advance its place by their ids", () => {
    const finds = [
      { ids: ["a", "b"], hit: hit(3, 0.9) },
      { ids: ["c"], hit: hit(2, 0.5) },
      { ids: ["x"], hit: hit(2, 0.4) },
    ];
    expect(intentPlace(finds, "x", 2, 0.35)).toEqual({ coverage: 0.4, matched: 2, passes: true, rank: 3 });
  });
  test("a failing hit before the item does not advance its place; an id placed twice counts once", () => {
    const finds = [
      { ids: ["a"], hit: hit(1, 0.9) },
      { ids: ["b"], hit: hit(3, 0.2) },
      { ids: ["c"], hit: hit(2, 0.5) },
      { ids: ["c", "x"], hit: hit(2, 0.5) },
    ];
    expect(intentPlace(finds, "x", 2, 0.35)?.rank).toBe(1);
  });
  test("each threshold binds: under either one, rank -1", () => {
    expect(intentPlace([{ ids: ["x"], hit: hit(1, 0.9) }], "x", 2, 0.35)).toEqual({
      coverage: 0.9,
      matched: 1,
      passes: false,
      rank: -1,
    });
    expect(intentPlace([{ ids: ["x"], hit: hit(5, 0.34) }], "x", 2, 0.35)?.passes).toBe(false);
    expect(intentPlace([{ ids: ["x"], hit: hit(2, 0.35) }], "x", 2, 0.35)?.passes).toBe(true);
  });
  test("a failing hit then a passing one: the passing one gives the place, as in the engine", () => {
    const finds = [
      { ids: ["x"], hit: hit(1, 0.9) },
      { ids: ["a"], hit: hit(2, 0.5) },
      { ids: ["x"], hit: hit(2, 0.4) },
    ];
    expect(intentPlace(finds, "x", 2, 0.35)).toEqual({ coverage: 0.4, matched: 2, passes: true, rank: 1 });
  });
});
