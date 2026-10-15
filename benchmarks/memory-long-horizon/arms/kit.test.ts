/**
 * Known-answer tests for the arm framework and the fixture arms' scorers: each check is shown to pass on a right
 * answer and to fail, for its reason, on a wrong one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { removeTempDirs, scriptedWorld } from "../harness/testkit";
import { keptOnlyIf, readVerdict } from "./bench";
import { fir, matchMemory, memories, recallAt4, recallInContext, type BenchCue, type CueResult } from "./cuebench";
import { e3Items, normValue, parseGold, readExtraction, scoreE3, type ExtractRecord } from "./extraction";
import { flagChecks, writeFlags, type ArmResult } from "./kit";
import { readReport } from "./migrate";
import { mismatch } from "./record";
import { scaleChecks } from "./scale";
import { readScopes } from "./scope-rows";
import { CHANNELS, POSITIONS, SHAPES, secretCases } from "./secrets";
import { readDump } from "./writers";

afterAll(removeTempDirs);

describe("flag runs", () => {
  async function played(answers: Parameters<typeof scriptedWorld>[0]) {
    const world = scriptedWorld(answers);
    writeFlags(world.home, "off");
    const session = world.newSession();
    await session.start();
    await session.prompt("what database do we use?", "typed", { cue: { needs: [], allowed: [], scope: "" } });
    await session.end();
    return world;
  }

  test("off: a plugin that prints nothing at delivery points passes every check", async () => {
    const checks = flagChecks([await played([])], "off");
    expect(checks.filter((item) => !item.ok)).toEqual([]);
    expect(checks.map((item) => item.id)).toEqual(["ran", "exit-0", "quiet", "no-context", "no-ledger"]);
  });

  test("off: a packet fails quiet and no-context; shadow also wants its ledger and wide events", async () => {
    const world = await played([{ event: "UserPromptSubmit", when: "database", context: "- Database: postgres" }]);
    expect(
      flagChecks([world], "off")
        .filter((item) => !item.ok)
        .map((item) => item.id),
    ).toEqual(["quiet", "no-context"]);
    expect(
      flagChecks([world], "shadow")
        .filter((item) => !item.ok)
        .map((item) => item.id),
    ).toEqual(["quiet", "no-context", "shadow-ledger", "wide-events"]);
  });

  test("a run that reached no delivery point fails `ran`", () => {
    expect(flagChecks([], "off").find((item) => item.id === "ran")!.ok).toBe(false);
  });
});

describe("the gate's comparison", () => {
  const result = (failed: string[]): ArmResult => ({
    arm: "x",
    flags: "on",
    checks: failed.map((id) => ({ id, ok: false, detail: `${id} detail` })),
    failed,
    ms: 0,
  });

  test("agrees with the exact recorded set, in any order", () => {
    expect(mismatch(result(["b", "a"]), { state: "red", failed: ["a", "b"] })).toBe("");
    expect(mismatch(result([]), { state: "green" })).toBe("");
  });

  test("names a check that fails for another reason, and a red arm that passes", () => {
    expect(mismatch(result(["a", "c"]), { state: "red", failed: ["a", "b"] })).toContain("now fails c: c detail");
    expect(mismatch(result([]), { state: "red", failed: ["a"] })).toContain('recorded red ["a"], ran []');
    expect(mismatch(result(["a"]), { state: "green" })).toContain("now fails a");
  });

  test("leaves unstable checks out", () => {
    expect(mismatch(result(["a", "flaky"]), { state: "red", failed: ["a"], unstable: ["flaky"] })).toBe("");
    expect(mismatch(result(["a"]), { state: "red", failed: ["a", "flaky"], unstable: ["flaky"] })).toBe("");
  });
});

describe("E3 scoring (R8's e3_score.py)", () => {
  const items = e3Items();
  const gold = new Map<number, ExtractRecord[]>(
    items.map((item, at) => {
      const parsed = parseGold(item.annotations);
      return [
        at,
        [
          ...parsed.slots.map((alts): ExtractRecord => ({ kind: "slot", ...alts[0]! })),
          ...parsed.rules.map((rule): ExtractRecord => ({
            kind: "policy",
            class: rule.classes[0]!,
            polarity: rule.polarity,
          })),
        ],
      ];
    }),
  );

  test("the fixture: 330 items, 217 plain, 60 in batch B", () => {
    expect(items.length).toBe(330);
    expect(items.filter((item) => ["request", "trap", "status", "paste"].includes(item.cat)).length).toBe(217);
    expect(items.filter((item) => item.batch === "B").length).toBe(60);
  });

  test("the gold annotations score recall 1 and no false durable", () => {
    const score = scoreE3(items, gold);
    expect(score.falseDurable).toEqual({ k: 0, n: 217 });
    expect(score.slotRecallB.k).toBe(score.slotRecallB.n);
    expect(score.ruleRecallB.k).toBe(score.ruleRecallB.n);
  });

  test("a record on every plain item is 217 false durables; a wrong value is no slot hit", () => {
    const noisy = new Map(
      items.map((_, at): [number, ExtractRecord[]] => [at, [{ kind: "slot", slot: "x", op: "set", value: "y" }]]),
    );
    const score = scoreE3(items, noisy);
    expect(score.falseDurable).toEqual({ k: 217, n: 217 });
    expect(score.slotRecallB.k).toBe(0);
  });

  test("values normalize as R8's norm_value; alternatives split only when the last has `=`", () => {
    expect(normValue(" PostgreSQL. ")).toBe("postgres");
    expect(normValue("v20")).toBe("20");
    expect(parseGold(["slot deploy.target=eks|deploy.target=aws"]).slots[0]!.map((alt) => alt.value)).toEqual([
      "eks",
      "aws",
    ]);
    expect(parseGold(["slot commit.style=conventional commits"]).slots[0]![0]!.value).toBe("conventional commits");
  });

  test("the answer must cover every item, one JSON line each", () => {
    expect(readExtraction('{"id":0,"records":[]}\n', 2)).toBeUndefined();
    expect(readExtraction("import: nothing to read\n", 1)).toBeUndefined();
    expect(readExtraction('{"id":0,"records":[]}\n{"id":1,"records":[]}\n', 2)?.size).toBe(2);
  });
});

describe("CueBench judging", () => {
  const pool = memories();
  const p01 = pool.find((memory) => memory.id === "p01")!;

  test("a bullet carries the memory whose content it holds, in any wording that keeps it", () => {
    expect(matchMemory(`- [rule · 2d · user] ${p01.text}`, pool)?.id).toBe("p01");
    expect(
      matchMemory(
        "- Rule you set: never merge pull requests yourself; push to the PR branch and let the user merge",
        pool,
      )?.id,
    ).toBe("p01");
    expect(matchMemory("- The weather is nice today", pool)).toBeUndefined();
  });

  test("recall@4 counts gold in the first four bullets; FIR counts any packet on a negative", () => {
    const cue = (cat: string, gold: string[]): BenchCue => ({
      id: cat,
      cat,
      scope: "",
      gold,
      cue: cat,
      last_paths: [],
      prev_turn: "",
      split: "test",
    });
    const results: CueResult[] = [
      { cue: cue("lex", ["p01"]), packet: true, matched: ["a", "b", "c", "p01"], earlier: [] },
      { cue: cue("para", ["p01"]), packet: true, matched: ["a", "b", "c", "d", "p01"], earlier: [] },
      { cue: cue("neg-hard", []), packet: true, matched: [undefined], earlier: [] },
      { cue: cue("neg-chat", []), packet: false, matched: [], earlier: ["p01"] },
    ];
    expect(recallAt4(results)).toEqual({ k: 1, n: 2 });
    expect(fir(results)).toEqual({ k: 1, n: 2 });
  });

  test("recall in context also counts a gold memory given earlier in the cue's session, never a later bullet", () => {
    const cue = (gold: string[]): BenchCue => ({
      id: "c",
      cat: "ctx",
      scope: "",
      gold,
      cue: "it loops",
      last_paths: [],
      prev_turn: "",
      split: "test",
    });
    const results: CueResult[] = [
      { cue: cue(["w06"]), packet: false, matched: [], earlier: ["r04", "w06"] },
      { cue: cue(["w06"]), packet: true, matched: ["a", "b", "c", "d", "w06"], earlier: [] },
      { cue: cue(["w06"]), packet: true, matched: ["w06"], earlier: [] },
    ];
    expect(recallInContext(results)).toEqual({ k: 2, n: 3 });
    expect(recallAt4(results)).toEqual({ k: 1, n: 3 });
  });

  test("an alias batch is kept only if FIR does not rise and recall drops by 0.02 at most", () => {
    const neg = (packet: boolean): CueResult => ({
      cue: { id: "n", cat: "neg-hard", scope: "", gold: [], cue: "", last_paths: [], prev_turn: "", split: "test" },
      packet,
      matched: [],
      earlier: [],
    });
    expect(keptOnlyIf(true, [neg(false)], [neg(true)]).ok).toBe(false);
    expect(keptOnlyIf(false, [neg(false)], [neg(true)]).ok).toBe(true);
    expect(keptOnlyIf(true, [neg(true)], [neg(true)]).ok).toBe(true);
    expect(readVerdict({ kept: false })).toEqual({ kept: false });
    expect(readVerdict(undefined)).toBeUndefined();
  });
});

describe("the scale arms' checks", () => {
  const run = (met: number, noisy: number, ms: number) => ({
    met,
    needing: 10,
    noisy,
    quiet: 10,
    submitMs: Array(100).fill(ms),
  });

  test("pass when recall holds at scale, silence holds and p99 is under 150 ms", () => {
    expect(scaleChecks(run(6, 0, 1), run(6, 0, 80), 20_000).filter((item) => !item.ok)).toEqual([]);
  });

  test("a store that answers nothing even when small fails gold-recall (the control)", () => {
    const failed = scaleChecks(run(0, 0, 1), run(0, 0, 80), 20_000)
      .filter((item) => !item.ok)
      .map((item) => item.id);
    expect(failed).toEqual(["gold-recall"]);
  });

  test("recall lost at scale, packets on negatives and a slow Submit each fail their check", () => {
    const failed = scaleChecks(run(6, 0, 1), run(5, 1, 200), 20_000)
      .filter((item) => !item.ok)
      .map((item) => item.id);
    expect(failed).toEqual(["gold-recall", "silence", "p99"]);
  });
});

describe("the entry-point contracts' parsers", () => {
  test("accept the shapes the arm headers give, and nothing else", () => {
    expect(readDump({ rows: [{ id: "a", text: "t" }], ledger: [] })?.rows.length).toBe(1);
    expect(readDump({ rows: [{ id: 1, text: "t" }], ledger: [] })).toBeUndefined();
    expect(readReport({ steps: ["swap"], sessions: [{ session: "s", repo: "r" }], unmappable: [] })?.steps).toEqual([
      "swap",
    ]);
    expect(readReport({ steps: "swap" })).toBeUndefined();
    expect(readScopes({ scopes: [""], of: { "a.ts": { repo: "r", scope: "" } } })?.scopes).toEqual([""]);
    expect(readScopes("import: nothing to read")).toBeUndefined();
  });
});

describe("the secret cases", () => {
  test("30 shapes × 4 channels × 3 positions, every value distinct", () => {
    const cases = secretCases();
    expect(SHAPES.length).toBe(30);
    expect(cases.length).toBe(30 * CHANNELS.length * POSITIONS.length);
    expect(new Set(cases.map((item) => item.secret)).size).toBe(cases.length);
    for (const item of cases) expect(item.text).toContain(item.secret);
  });

  test("are the same on every run (a seeded stream)", () => {
    expect(secretCases().map((item) => item.secret)).toEqual(secretCases().map((item) => item.secret));
  });
});
