import { describe, expect, test } from "bun:test";
import {
  coverageBucket,
  coverageLines,
  coverageSplit,
  intentPlace,
  plantedCoverageLine,
  surfacedBy,
  rulePrecisionLines,
  surfacedLines,
  surfacedSplit,
  type AskCoverage,
  type SurfacedRow,
} from "./ask-coverage";

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
    const under = { ...base, intent: { coverage: 0.2, matched: 1, passes: false, rank: -1, pastCut: false } };
    expect(coverageBucket({ rank: -1, cached: true, coverage: under })).toBe("under thresholds");
    const over = { ...base, intent: { coverage: 0.6, matched: 3, passes: true, rank: 9, pastCut: false } };
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
  test("the top-level buckets sum to the rank -1 count, per variant", () => {
    const s = coverageSplit(rows, "hidden");
    expect(s.unranked).toBe(4);
    expect(s.notSentPrefilterRejects + s.notInReplay + s.noRequests + s.noMatch + s.notCached).toBe(s.unranked);
    expect(s).toMatchObject({
      notSentPrefilterRejects: 1,
      notInReplay: 0,
      noRequests: 1,
      noMatch: 2,
      noSharedTerm: 2,
      under: 0,
      pastCut: 0,
      over: 0,
    });
    expect(coverageSplit(rows, "control").unranked).toBe(1);
  });
  test("the summary names each bucket and leaves out an empty not-cached one", () => {
    const [h, d, replay] = coverageLines(rows);
    expect(h).toBe(
      "ask-diag: hidden rank -1 4/5: not sent, prefilter rejects 1, not in replay 0, no intent requests 1, " +
        "requests but no match 2 (no shared term 2, under thresholds 0, passes but past the first intentHits raw " +
        "hits 0, over thresholds 0)",
    );
    expect(d).toStartWith("ask-diag: decoy rank -1 1/1: ");
    expect(replay).toBe("ask-diag: not in replay, every row (ranked or not): hidden 0/5, decoy 0/1");
    expect(coverageLines([])).toEqual([]);
  });
});

describe("not in replay", () => {
  const missing = { ...base, heldRequests: 0, replayRequests: -1 };
  test("a missing replay line is its own bucket, apart from a line with no requests", () => {
    expect(coverageBucket({ rank: -1, cached: true, coverage: missing })).toBe("not in replay");
    const empty = { ...base, heldRequests: 0, replayRequests: 0 };
    expect(coverageBucket({ rank: -1, cached: true, coverage: empty })).toBe("no intent requests");
    // Not sent with the prefilter rejecting still wins: it would not have been asked either way.
    const notSent = { ...missing, cardRead: false, notSentPrefilterRejects: true };
    expect(coverageBucket({ rank: -1, cached: true, coverage: notSent })).toBe("not sent, prefilter rejects");
  });
  test("every row's replay misses are counted, ranked or not, and printed only with a replay loaded", () => {
    const rows = [
      { variant: "hidden", rank: -1, cached: true, coverage: missing },
      { variant: "hidden", rank: 2, cached: true, coverage: missing },
      { variant: "hidden", rank: 0, cached: true, coverage: base },
      { variant: "control", rank: -1, cached: true, coverage: { ...base, heldRequests: 0, replayRequests: 0 } },
    ];
    expect(coverageSplit(rows, "hidden")).toMatchObject({ notInReplay: 1, noRequests: 0, rowsNotInReplay: 2 });
    expect(coverageSplit(rows, "control")).toMatchObject({ notInReplay: 0, noRequests: 1, rowsNotInReplay: 0 });
    const lines = coverageLines(rows);
    expect(lines[0]).toContain("not in replay 1, no intent requests 0");
    expect(lines.at(-1)).toBe("ask-diag: not in replay, every row (ranked or not): hidden 2/3, decoy 0/1");
    const noReplay = { ...base, heldRequests: 0, replayRequests: null };
    expect(coverageLines([{ variant: "hidden", rank: -1, cached: true, coverage: noReplay }])).toHaveLength(1);
  });
});

describe("intentPlace (partner.ts intentFinds' cut, applied lab-side)", () => {
  const hit = (matched: number, coverage: number) => ({ matched, coverage });
  // The engine's call and an unbounded one agree when the store returns the same order (the usual case).
  const place = (finds: { ids: string[]; hit: { matched: number; coverage: number } }[], hits = 6) =>
    intentPlace(finds, finds, "x", 2, 0.35, hits);
  test("no hit holds the item: null", () => {
    expect(place([])).toBeNull();
    expect(place([{ ids: ["a"], hit: hit(3, 0.9) }])).toBeNull();
  });
  test("passing hits before the item advance its place by their ids", () => {
    const finds = [
      { ids: ["a", "b"], hit: hit(3, 0.9) },
      { ids: ["c"], hit: hit(2, 0.5) },
      { ids: ["x"], hit: hit(2, 0.4) },
    ];
    expect(place(finds)).toEqual({ coverage: 0.4, matched: 2, passes: true, rank: 3, pastCut: false });
  });
  test("a failing hit before the item does not advance its place; an id placed twice counts once", () => {
    const finds = [
      { ids: ["a"], hit: hit(1, 0.9) },
      { ids: ["b"], hit: hit(3, 0.2) },
      { ids: ["c"], hit: hit(2, 0.5) },
      { ids: ["c", "x"], hit: hit(2, 0.5) },
    ];
    expect(place(finds)?.rank).toBe(1);
  });
  test("each threshold binds: under either one, rank -1", () => {
    expect(place([{ ids: ["x"], hit: hit(1, 0.9) }])).toEqual({
      coverage: 0.9,
      matched: 1,
      passes: false,
      rank: -1,
      pastCut: false,
    });
    expect(place([{ ids: ["x"], hit: hit(5, 0.34) }])?.passes).toBe(false);
    expect(place([{ ids: ["x"], hit: hit(2, 0.35) }])?.passes).toBe(true);
  });
  test("a failing hit then a passing one: the passing one gives the place, as in the engine", () => {
    const finds = [
      { ids: ["x"], hit: hit(1, 0.9) },
      { ids: ["a"], hit: hit(2, 0.5) },
      { ids: ["x"], hit: hit(2, 0.4) },
    ];
    expect(place(finds)).toEqual({ coverage: 0.4, matched: 2, passes: true, rank: 1, pastCut: false });
  });
  test("a passing hit behind intentHits failing raw hits is past the cut, though first among passing hits", () => {
    // The engine reads only the first 6 raw hits (cards.ts intentFinds' k), thresholds after: all 6 fail.
    const failing = Array.from({ length: 6 }, (_, i) => ({ ids: [`f${i}`], hit: hit(1, 0.9) }));
    const all = [...failing, { ids: ["x"], hit: hit(3, 0.8) }];
    expect(intentPlace(failing, all, "x", 2, 0.35, 6)).toEqual({
      coverage: 0.8,
      matched: 3,
      passes: true,
      rank: -1,
      pastCut: true,
    });
    // Even if the engine's call returned more than k, only its first `hits` raw hits count.
    expect(intentPlace(all, all, "x", 2, 0.35, 6)).toMatchObject({ rank: -1, pastCut: true });
    // With a cut of 7 raw hits it is inside, and first among the passing ones.
    expect(intentPlace(all, all, "x", 2, 0.35, 7)).toMatchObject({ rank: 0, pastCut: false });
  });
  test("the engine places at most intentHits ids, and a hash its own call skipped is past the cut", () => {
    const finds = [{ ids: ["a", "b", "x"], hit: hit(3, 0.9) }];
    expect(intentPlace(finds, finds, "x", 2, 0.35, 2)).toMatchObject({ passes: true, rank: -1, pastCut: true });
    expect(intentPlace(finds, finds, "x", 2, 0.35, 3)).toMatchObject({ rank: 2, pastCut: false });
    // The engine's call returned nothing for it (fewer accepted hashes in its 2k search): past the cut.
    expect(intentPlace([], finds, "x", 2, 0.35, 6)).toMatchObject({ passes: true, rank: -1, pastCut: true });
  });
  test("intentByKind (D200): a carded hit under the shared floor passes at its own, and past the cut it is placed", () => {
    const byKind = { cardCoverage: 0.1, cardHits: 2 };
    const full = Array.from({ length: 6 }, (_, i) => ({ ids: [`f${i}`], hit: hit(3, 0.9) }));
    const weak = { ids: ["x"], hit: hit(2, 0.15), carded: true };
    // Off: under the shared 0.35, a failing hit.
    expect(intentPlace([weak], [weak], "x", 2, 0.35, 6)).toMatchObject({ passes: false });
    // On, inside the cut: placed by its own floor.
    expect(intentPlace([weak], [weak], "x", 2, 0.35, 6, byKind)).toMatchObject({ passes: true, rank: 0 });
    // On, behind 6 passing raw hits: one of the carded places after them, as the engine keeps it (keepIntents).
    const rows = [...full, weak];
    expect(intentPlace(rows, rows, "x", 2, 0.35, 6, byKind)).toMatchObject({ rank: 6, pastCut: false });
    // The same hit uncarded stays under the shared floor.
    const plain = [...full, { ...weak, carded: false }];
    expect(intentPlace(plain, plain, "x", 2, 0.35, 6, byKind)).toMatchObject({ passes: false });
  });
  test("past the cut lands in its own bucket, apart from over thresholds", () => {
    const past = { ...base, intent: { coverage: 0.8, matched: 3, passes: true, rank: -1, pastCut: true } };
    expect(coverageBucket({ rank: -1, cached: true, coverage: past })).toBe("past the intentHits cut");
    const s = coverageSplit([{ variant: "hidden", rank: -1, cached: true, coverage: past }], "hidden");
    expect(s).toMatchObject({ pastCut: 1, over: 0, noMatch: 1 });
  });
});

describe("surfaced split (D173)", () => {
  const t = (o: Partial<SurfacedRow>): SurfacedRow => ({ variant: "control", delivered: false, ...o });
  test("flagged wins whatever carried it; delivered unflagged is a rule path; cited only is listed only", () => {
    expect(surfacedBy(t({}))).toBeNull();
    expect(surfacedBy(t({ readerFlagged: true }))).toBeNull();
    expect(surfacedBy(t({ delivered: true, readerFlagged: true, why: "grounded-conflict" }))).toBe("flagged");
    expect(surfacedBy(t({ askCited: true, readerFlagged: true }))).toBe("flagged");
    expect(surfacedBy(t({ delivered: true, why: "fallback" }))).toBe("rule path");
    expect(surfacedBy(t({ delivered: true, askCited: true, why: "sources" }))).toBe("rule path");
    expect(surfacedBy(t({ askCited: true }))).toBe("listed only");
  });
  test("the parts sum to surfaced; rule paths by why, most first; flagged in pool beside in pool", () => {
    const rows = [
      t({ delivered: true, readerFlagged: true, poolHas: true, why: "reader" }),
      t({ delivered: true, why: "fallback", poolHas: false }),
      t({ delivered: true, why: "grounded-conflict", poolHas: true }),
      t({ delivered: true, why: "grounded-conflict", poolHas: true }),
      t({ askCited: true, poolHas: true }),
      t({ poolHas: true }),
      t({ variant: "hidden", askCited: true, readerFlagged: true, poolHas: true }),
    ];
    const s = surfacedSplit(rows, "control");
    expect(s).toEqual({
      tasks: 6,
      surfaced: 5,
      flagged: 1,
      rulePath: 3,
      listedOnly: 1,
      byWhy: { "grounded-conflict": 2, fallback: 1 },
      inPool: 5,
      flaggedInPool: 1,
    });
    expect(s.flagged + s.rulePath + s.listedOnly).toBe(s.surfaced);
    expect(surfacedLines("TOTAL", rows)).toEqual([
      "TOTAL hidden surfaced 1/1: flagged 1, rule path 0, listed only 0; hidden in pool 1, hidden flagged in pool 1",
      "TOTAL decoys surfaced 5/6: flagged 1, rule path 3 (grounded-conflict 2, fallback 1), listed only 1; " +
        "decoys in pool 5, decoys flagged in pool 1",
    ]);
  });
  test("no pool data: no pool part; a delivery with no why is 'unknown'; no rows: no lines", () => {
    expect(surfacedLines("x", [t({ delivered: true, why: "" })])).toEqual([
      "x decoys surfaced 1/1: flagged 0, rule path 1 (unknown 1), listed only 0",
    ]);
    expect(surfacedLines("x", [])).toEqual([]);
  });
  test("rule precision: every delivery by its path, flagged or not; the reader's own deliveries left out", () => {
    const rows = [
      t({ delivered: true, readerFlagged: true, poolHas: true, why: "reader" }),
      t({ variant: "hidden", delivered: true, readerFlagged: true, poolHas: true, why: "grounded-conflict" }),
      t({ variant: "hidden", delivered: true, poolHas: false, why: "grounded-conflict" }),
      t({ delivered: true, poolHas: true, why: "grounded-conflict" }),
      t({ delivered: true, poolHas: true, why: "fallback" }),
      t({ delivered: true, poolHas: true, why: "fallback" }),
      t({ askCited: true, poolHas: true }),
    ];
    expect(rulePrecisionLines("TOTAL", rows)).toEqual([
      "TOTAL rule precision (delivered by path, hidden/decoys: all; unflagged; read unflagged):",
      "TOTAL   grounded-conflict 2/1; 1/1; 0/1",
      "TOTAL   fallback 0/2; 0/2; 0/2  decoys outnumber hidden",
    ]);
    expect(rulePrecisionLines("x", [t({ askCited: true })])).toEqual([]);
    // No pool data (no reader): the read-unflagged column is left out rather than shown as 0/0.
    expect(rulePrecisionLines("x", [t({ delivered: true, why: "fallback" })])).toEqual([
      "x rule precision (delivered by path, hidden/decoys: all; unflagged):",
      "x   fallback 0/1; 0/1  decoys outnumber hidden",
    ]);
  });
  test("planted coverage: null without replay facts, a warning below 100%", () => {
    expect(plantedCoverageLine([t({})])).toBeNull();
    expect(plantedCoverageLine([t({ inReplay: true }), t({ variant: "hidden", inReplay: true })])).toBe(
      "planted items with an intent replay line: hidden 1/1, decoys 1/1",
    );
    const line = plantedCoverageLine([t({ inReplay: false }), t({ variant: "hidden", inReplay: true })]);
    expect(line).toStartWith("planted items with an intent replay line: hidden 1/1, decoys 0/1  WARNING: below 100%");
    expect(line).toContain("not in replay: hidden 0, decoys 1");
  });
});
