/**
 * The hard bench's harness works: its world is deterministic, its oracle scores hand-built packets correctly,
 * and a small slice runs end to end through the product. It never asserts the product's score on the bench,
 * so the bench stays a measurement, not a CI gate.
 */
import { describe, expect, test } from "bun:test";
import { digest, runHard } from "./hard";
import { contentTokens, Oracle, stem } from "./hard-oracle";
import {
  buildCases,
  buildWorld,
  FILLER_ROWS,
  type HardCase,
  SLOTS,
  type Statement,
  statementFor,
  UNITS,
  type World,
} from "./hard-world";

const words = (text: string) => contentTokens(text.replace(/\{\w+\}/g, " ")).map(stem);

function caseOf(world: World, category: HardCase["category"]): HardCase {
  const c = buildCases(world, "dev").find((x) => x.category === category);
  if (!c) throw new Error(`no ${category} case`);
  return c;
}

describe("hard bench world", () => {
  test("the same seed gives the same world and cases; dev and test share no cue or need", () => {
    const a = buildWorld(300);
    const b = buildWorld(300);
    expect(b.events.map((e) => e.text)).toEqual(a.events.map((e) => e.text));
    const dev = buildCases(a, "dev");
    const locked = buildCases(a, "test");
    expect(buildCases(b, "dev")).toEqual(dev);
    const devCues = new Set(dev.map((c) => c.cue));
    const devNeeds = new Set(dev.flatMap((c) => c.needs));
    expect(locked.filter((c) => devCues.has(c.cue)).map((c) => c.id)).toEqual([]);
    expect(locked.filter((c) => c.needs.some((n) => devNeeds.has(n))).map((c) => c.id)).toEqual([]);
  });

  test("the full world has 20k distinct background rows", () => {
    const world = buildWorld();
    expect(world.filler.length).toBe(FILLER_ROWS);
    expect(new Set(world.filler).size).toBe(FILLER_ROWS);
    expect(world.events.length).toBe(FILLER_ROWS + world.statements.length);
  });

  test("paraphrases and aliases share no word with anything the slot's facts say", () => {
    const shared: string[] = [];
    for (const [slot, def] of Object.entries(SLOTS)) {
      const said = new Set(
        [...def.facts, ...def.updates, ...def.migrations, ...def.drops, ...def.values].flatMap(words),
      );
      for (const t of [...def.para.dev, ...def.para.test]) {
        for (const w of words(t)) if (said.has(w)) shared.push(`${slot}: "${t}" says ${w}`);
      }
      for (const u of UNITS) {
        const own = new Set(words(u.id.replace(/-/g, " ")));
        for (const alias of [u.alias.dev, u.alias.test]) {
          for (const w of words(alias)) if (said.has(w) || own.has(w)) shared.push(`${u.id}: "${alias}" says ${w}`);
        }
      }
    }
    expect(shared).toEqual([]);
  });

  test("named cues and every fact template carry the slot's key word", () => {
    const missing: string[] = [];
    for (const [slot, def] of Object.entries(SLOTS)) {
      for (const t of [...def.facts, ...def.named.dev, ...def.named.test]) {
        if (!words(t).includes(stem(def.key))) missing.push(`${slot}: ${t}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("hard bench oracle", () => {
  const world = buildWorld(300);
  const oracle = new Oracle(world);
  const named = caseOf(world, "named");
  const gold = statementFor(world, named.needs[0]!);
  const bullet = (text: string) => `- [fact · 0m · user] ${text.replace(/\.$/, "")}`;

  test("the gold statement alone passes every check", () => {
    expect(oracle.score(named, [bullet(gold.text)], true).fails).toEqual([]);
  });

  test("an empty packet fails only the need", () => {
    expect(oracle.score(named, [], false).fails).toEqual(["need"]);
  });

  test("a background row fails precision", () => {
    expect(oracle.score(named, [bullet(gold.text), bullet(world.filler[0]!)], true).fails).toEqual(["precision"]);
  });

  test("a superseded statement fails stale; the statement that replaced it does not", () => {
    const old = world.statements.find((s) => oracle.isStale(s) && s.value !== undefined)!;
    const now = statementFor(world, old.slot);
    const c: HardCase = { ...named, needs: [old.slot] };
    expect(oracle.score(c, [bullet(now.text)], true).fails).toEqual([]);
    expect(oracle.score(c, [bullet(now.text), bullet(old.text)], true).fails).toEqual(["stale"]);
  });

  test("a rewritten copula counts by its value: current passes, superseded is stale, unknown is false", () => {
    const copula = /^The (.+?) is (?:now )?(.+)\.$/;
    const says = (stale: boolean) => world.statements.find((x) => {
      return x.text.match(copula)?.[2] === x.value && oracle.isStale(x) === stale;
    })!;
    const score = (s: Statement, value: string) => {
      const c: HardCase = { ...named, needs: [s.slot] };
      return oracle.score(c, [`- The ${s.text.match(copula)![1]} is ${value}.`], true).fails;
    };
    const live = says(false);
    const old = says(true);
    expect(score(live, live.value!)).toEqual([]);
    expect(score(live, "Nonexistent")).toEqual(["need", "precision"]);
    expect(score(old, old.value!)).toEqual(["need", "stale"]);
  });

  test("a negative fails silence on any packet and passes on none", () => {
    const ack = caseOf(world, "ack");
    expect(oracle.score(ack, [], false).fails).toEqual([]);
    expect(oracle.score(ack, [bullet(gold.text)], true).fails).toEqual(["silence"]);
  });

  test("restating what the cue already says is redundant", () => {
    const c = caseOf(world, "redundant");
    const said = statementFor(world, c.states[0]!);
    const asked = statementFor(world, c.needs[0]!);
    expect(oracle.score(c, [bullet(asked.text)], true).fails).toEqual([]);
    expect(oracle.score(c, [bullet(asked.text), bullet(said.text)], true).fails).toEqual(["redundant"]);
  });
});

describe("hard bench harness", () => {
  // Known pass: an anchor codename matches one row. Known fail: a need no statement answers.
  const slice = (world: World) => [
    ...buildCases(world, "dev").filter((c) => c.category === "anchor"),
    { ...caseOf(world, "named"), id: "dev-unanswerable", needs: ["billing.no-such-slot"] },
  ];

  test("a small slice runs through the product, isolated and deterministic", () => {
    const envBefore = { ...process.env };
    const nowBefore = Date.now;
    const run = () => runHard({ splits: ["dev"], fillerRows: 300, timingReps: 0, cases: slice });
    const first = run();
    const second = run();
    const anchors = first.results.filter((r) => r.category === "anchor");
    expect(anchors.length).toBe(3);
    expect(anchors.map((r) => r.fails)).toEqual([[], [], []]);
    expect(first.results.find((r) => r.id === "dev-unanswerable")!.fails).toContain("need");
    expect(digest(second.results)).toBe(digest(first.results));
    expect(first.scale.rows).toBeGreaterThan(0);
    expect(process.env).toEqual(envBefore);
    expect(Date.now).toBe(nowBefore);
  });
});
