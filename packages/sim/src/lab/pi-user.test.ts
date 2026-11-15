import { describe, expect, test } from "bun:test";
import { buildWorld, type World } from "../world";
import { recapOf } from "./pi-day";
import {
  dayKinds,
  dayOf,
  parseDaySize,
  parseMix,
  planUser,
  suiteTemplates,
  userWorldOf,
  withDayRecaps,
} from "./pi-user";
import { parseSuites, prepareWorld, SUITES } from "./suites";

const MIX = { hidden: 1, control: 1, neutral: 8 };

/**
 * `suiteTemplates` over one world built per seed, not one per suite: each suite plants into its own lists and maps over
 * that world's items (as cards-disk.test.ts shares its worlds, D819), so the templates are the ones a fresh world
 * gives; the test checks that against `suiteTemplates` and that no base item changed. Thirty users of six suites
 * built 180 worlds (3.7 s); this builds 30.
 */
function sharedTemplates(seed: number, suites: readonly string[]): Record<string, string[]> {
  const base = buildWorld({ seed: seed * 1_000 });
  const printed = JSON.stringify([base.items, [...base.facts], base.arcs, base.people, base.user, base.sources]);
  const out = Object.fromEntries(
    suites.map((s) => {
      const world: World = {
        ...base,
        people: [...base.people],
        arcs: [...base.arcs],
        facts: new Map(base.facts),
        items: [...base.items],
        sources: { ...base.sources },
      };
      prepareWorld(s, world, seed);
      return [s, SUITES[s]!(world, seed, "hidden").map((t) => t.template)];
    }),
  );
  expect(JSON.stringify([base.items, [...base.facts], base.arcs, base.people, base.user, base.sources])).toBe(printed);
  return out;
}

describe("pi-user (H16)", () => {
  test("flags: day size and mix", () => {
    expect(parseDaySize("12-20")).toEqual([12, 20]);
    expect(parseDaySize("16")).toEqual([16, 16]);
    expect(() => parseDaySize("20-12")).toThrow();
    expect(parseMix("1:1:8")).toEqual(MIX);
    expect(() => parseMix("1:1")).toThrow();
    expect(() => parseMix("0:0:0")).toThrow();
  });

  test("a day's kinds keep 1:1:8 and at least one hidden and one control", () => {
    expect(dayKinds(12, MIX)).toEqual({ hidden: 1, control: 1, neutral: 10 });
    expect(dayKinds(20, MIX)).toEqual({ hidden: 2, control: 2, neutral: 16 });
    expect(dayKinds(1, MIX)).toEqual({ hidden: 1, control: 0, neutral: 0 });
    for (let n = 1; n <= 30; n++) {
      const k = dayKinds(n, MIX);
      expect(k.hidden + k.control + k.neutral).toBe(n);
    }
    expect(dayKinds(10, { hidden: 1, control: 0, neutral: 0 })).toEqual({ hidden: 10, control: 0, neutral: 0 });
  });

  test("a plan: days in the size range, each template once per user, deterministic per seed", () => {
    const suites = parseSuites("train");
    const templates = suiteTemplates(41, suites);
    const plan = planUser(41, templates, { days: 8, size: [12, 20], mix: MIX });
    expect(plan.length).toBe(8);
    for (const d of plan) {
      expect(d.length).toBeGreaterThanOrEqual(12);
      expect(d.length).toBeLessThanOrEqual(20);
      const k = dayKinds(d.length, MIX);
      expect(d.filter((e) => e.variant === "hidden").length).toBe(k.hidden);
      expect(d.filter((e) => e.variant === "control").length).toBe(k.control);
    }
    const keys = plan.flat().map((e) => `${e.suite}|${e.template}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(planUser(41, templates, { days: 8, size: [12, 20], mix: MIX })).toEqual(plan);
    expect(planUser(42, suiteTemplates(42, suites), { days: 8, size: [12, 20], mix: MIX })).not.toEqual(plan);
    // Weeks (D874): a plan longer than the templates. Over 30 users of four weeks: no template planted twice, none
    // both planted and asked as a neutral request (its item would sit in that request's world), none twice in a day,
    // and every day's kinds as dayKinds says.
    expect(sharedTemplates(41, suites)).toEqual(templates);
    for (let seed = 41; seed <= 70; seed++) {
      const long = planUser(seed, sharedTemplates(seed, suites), { days: 28, size: [12, 20], mix: MIX });
      expect(long.length).toBe(28);
      const key = (e: { suite: string; template: string }) => `${e.suite}|${e.template}`;
      const planted = long
        .flat()
        .filter((e) => e.variant !== "neutral")
        .map(key);
      expect(new Set(planted).size).toBe(planted.length);
      const neutral = new Set(
        long
          .flat()
          .filter((e) => e.variant === "neutral")
          .map(key),
      );
      expect(planted.filter((k) => neutral.has(k))).toEqual([]);
      for (const d of long) {
        expect(new Set(d.map(key)).size).toBe(d.length);
        const k = dayKinds(d.length, MIX);
        expect([
          d.filter((e) => e.variant === "hidden").length,
          d.filter((e) => e.variant === "control").length,
        ]).toEqual([k.hidden, k.control]);
      }
    }
    // Too many planted requests for the templates throws.
    expect(() =>
      planUser(41, { train1: ["a", "b", "c"] }, { days: 4, size: [3, 3], mix: { hidden: 1, control: 0, neutral: 0 } }),
    ).toThrow(/need more templates/);
    expect(() => planUser(41, { heldout13: ["a", "b", "c", "d"] }, { days: 1, size: [4, 4], mix: MIX })).toThrow(
      /no neutral/,
    );
  });

  test("the user's world: one item per planted request, unique ids, the suites' task texts and kinds", () => {
    const suites = parseSuites("train");
    const plan = planUser(42, suiteTemplates(42, suites), { days: 3, size: [12, 14], mix: MIX });
    const u = userWorldOf(42, plan);
    const base = buildWorld({ seed: 42_000 });
    expect(u.tasks.length).toBe(plan.flat().length);
    expect(u.daySizes).toEqual(plan.map((d) => d.length));
    const planted = u.tasks.filter((t) => t.planted);
    expect(planted.length).toBe(plan.flat().filter((e) => e.variant !== "neutral").length);
    // Every planted item is in the world once, with an id no base item has, and a ref naming no template.
    const ids = u.world.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const baseIds = new Set(base.items.map((i) => i.id));
    for (const t of planted) {
      expect(baseIds.has(t.planted!)).toBe(false);
      const item = u.world.items.find((i) => i.id === t.planted)!;
      expect(item.ref).not.toContain(t.type);
    }
    expect(u.tasks.every((t) => t.kind !== "neutral" || t.id.includes("-neutral:"))).toBe(true);
    expect(u.tasks.every((t) => t.must.length === 1 && t.event === "user_message")).toBe(true);
    // The same request text as the suite's own world gives it.
    const first = u.tasks[0]!;
    const own = suiteTemplates(42, [first.suite]);
    expect(own[first.suite]).toContain(first.type);
    expect(u.clashes).toBeGreaterThanOrEqual(0);
  });

  test("recaps close each day; dayOf maps tasks to days", () => {
    const suites = parseSuites("train");
    const plan = planUser(41, suiteTemplates(41, suites), { days: 2, size: [12, 12], mix: MIX });
    const u = userWorldOf(41, plan);
    const out = withDayRecaps(u.tasks, u.daySizes, (t, d) => recapOf(t, `w41:user:day${d}:recap`));
    expect(out.length).toBe(26);
    expect(out[12]!.id).toBe("w41:user:day0:recap");
    expect(out[25]!.id).toBe("w41:user:day1:recap");
    expect(out[12]!.must).toEqual([]);
    expect((out[12] as { planted?: string }).planted).toBeUndefined();
    const days = dayOf(u.tasks, u.daySizes);
    expect(days.get(u.tasks[0]!.id)).toBe(0);
    expect(days.get(u.tasks[23]!.id)).toBe(1);
  });
});
