import { describe, expect, test } from "bun:test";
import { agreement, coveredKeys, retrievalDiff, screenArgs, summarize, taskKey, type Row } from "./retrieval-screen";

const row = (over: Partial<Row>): Row => ({
  suite: "train1",
  seed: 41,
  variant: "hidden",
  template: "t1",
  returned: true,
  cached: true,
  delivered: false,
  askCited: false,
  poolHas: false,
  inReplay: true,
  ...over,
});

describe("retrieval screen (audit 2026-11-06 F25)", () => {
  test("a task is covered when neither variant's planted item lacks an intent replay line", () => {
    const rows = [
      row({ template: "a" }),
      row({ template: "a", variant: "control" }),
      row({ template: "b", inReplay: false }),
      row({ template: "b", variant: "control" }),
      row({ template: "c", cached: false, inReplay: undefined }), // not cached: no reading, not a known hole
      row({ template: "c", variant: "control" }),
      row({ template: "d" }), // one variant only: not a pair
    ];
    expect([...coveredKeys(rows)].sort()).toEqual(["train1|41|a", "train1|41|c"]);
  });

  test("the diff lists every retrieval field that moved, task by task", () => {
    const base = [row({ template: "a" }), row({ template: "b", variant: "control", poolHas: true })];
    const next = [
      row({ template: "a", poolHas: true, askCited: true }),
      row({ template: "b", variant: "control", poolHas: false }),
    ];
    const d = retrievalDiff(base, next);
    expect(d.get(taskKey(next[0]!, true))).toEqual(["+pool", "+surfaced"]);
    expect(d.get(taskKey(next[1]!, true))).toEqual(["-pool"]);
    expect(retrievalDiff(base, base).size).toBe(0);
  });

  test("summaries count each field per variant over the given keys", () => {
    const rows = [
      row({ template: "a", poolHas: true, delivered: true }),
      row({ template: "a", variant: "control", poolHas: true }),
      row({ template: "b", returned: false, cached: false }),
      row({ template: "b", variant: "control" }),
    ];
    const s = summarize(rows, new Set(["train1|41|a"]));
    expect(s.hidden).toEqual({ n: 1, returned: 1, cached: 1, pool: 1, surfaced: 1 });
    expect(s.control).toEqual({ n: 1, returned: 1, cached: 1, pool: 1, surfaced: 0 });
    expect(summarize(rows).hidden.n).toBe(2);
  });

  test("agreement: the screen's task moves against the full funnel's on the screen's covered tasks", () => {
    const fullBase = [row({ template: "a" }), row({ template: "b" }), row({ suite: "train2", template: "z" })];
    const fullNext = [
      row({ template: "a", poolHas: true }),
      row({ template: "b" }),
      row({ suite: "train2", template: "z", poolHas: true }),
    ];
    const screenBase = [row({ template: "a" }), row({ template: "b" })];
    const same = agreement({
      fullBase,
      fullNext,
      screenBase,
      screenNext: [row({ template: "a", poolHas: true }), row({ template: "b" })],
    });
    expect(same).toMatchObject({ tasks: 2, agree: 2, disagree: [], fullMoved: 1, screenMoved: 1, signsAgree: true });
    const off = agreement({
      fullBase,
      fullNext,
      screenBase,
      screenNext: [row({ template: "a" }), row({ template: "b", cached: false })],
    });
    expect(off.agree).toBe(0);
    expect(off.disagree.map((d) => d.key).sort()).toEqual(["train1|hidden|41|a", "train1|hidden|41|b"]);
    expect(off.signsAgree).toBe(false);
  });

  test("the funnel arguments put the screen's grid first and its prefix after --", () => {
    const a = screenArgs(
      { suites: ["train2", "train5"], seeds: [41], limit: 12 },
      ["--set", "{}", "--", "--reader", "stub"],
      "/tmp/o.json",
    );
    expect(a).toEqual([
      "--suite",
      "train2,train5",
      "--seeds",
      "41",
      "--json",
      "/tmp/o.json",
      "--set",
      "{}",
      "--",
      "--limit",
      "12",
      "--reader",
      "stub",
    ]);
    expect(() => screenArgs({ suites: ["train1"], seeds: [41], limit: 0 }, ["--suite", "train3"], "/x")).toThrow(
      /--suite/,
    );
  });
});
