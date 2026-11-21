/**
 * The blob merge's semantics (D2004, review round): counters union, but fields that are one observation —
 * a run count, the last answer's ids, an unjudged outstanding — come from the newer row or not at all.
 */
import { describe, expect, test } from "bun:test";
import { mergeFrozenEconomy, type FrozenEconomy } from "./economy";
import { mergeFrozenSessions } from "./partner-freeze";
import { mergeFrozenYields } from "./source-yield";

const eco = (asked: FrozenEconomy["asked"]): FrozenEconomy => ({
  n: 1,
  changed: 0,
  exposure: 0,
  asked,
  side: [],
  arms: [],
  kinds: [],
  finds: [],
  forms: [],
});

describe("the blob merge's semantics (D2004 review)", () => {
  test("a cleared source run is not resurrected by the older blob's count", () => {
    const prior = { sources: [["mail", { empty: 4, at: 100, used: false }]] } as never;
    const live = { sources: [["mail", { empty: 0, at: 200, used: true }]] } as never;
    expect(mergeFrozenYields(prior, live)!.sources).toEqual([["mail", { empty: 0, at: 200, used: true }]]);
  });

  test("a newer answer's smaller id set stands: counts union, the snapshot does not", () => {
    const prior = eco([["q", { prints: [1, 2], ids: ["a", "b"], at: 100, n: 3, changed: 1, exposure: 5 }]]);
    const live = eco([["q", { prints: [3], ids: ["b", "c"], at: 200, n: 4, changed: 0, exposure: 2 }]]);
    const row = mergeFrozenEconomy(prior, live)!.asked[0]![1];
    expect(row.ids).toEqual(["b", "c"]);
    expect(row.prints).toEqual([3]);
    expect(row.n).toBe(4);
    expect(row.changed).toBe(1);
    expect(row.exposure).toBe(5);
    expect(row.at).toBe(200);
  });

  test("a judged outstanding does not come back through a kept prior session", () => {
    const prior = [
      {
        sessionId: "s",
        turn: 3,
        ledger: { delivered: [], versions: [], shown: [] } as never,
        delivered: [],
        outstanding: [
          { injectionId: "i1", sourceIds: ["mail"], situation: "general", terms: [], deliveredTurn: 2 },
          { injectionId: "i2", sourceIds: ["mail"], situation: "general", terms: [], deliveredTurn: 3 },
        ],
      },
    ];
    const merged = mergeFrozenSessions(prior, null, new Set(["i1"]))!;
    expect(merged[0]!.outstanding!.map((o) => o.injectionId)).toEqual(["i2"]);
    // All judged: the field goes away entirely, and a session without the flag keeps it.
    const gone = mergeFrozenSessions(prior, null, new Set(["i1", "i2"]))!;
    expect(gone[0]!.outstanding).toBeUndefined();
  });
});
