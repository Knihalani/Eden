import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
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
import { parseSuites } from "./suites";

const MIX = { hidden: 1, control: 1, neutral: 8 };

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
    // Weeks (D874): past the templates the pool refills; the days before the refill are the short plan's, a template
    // is never planted twice, and planted slots still follow dayKinds.
    const long = planUser(41, templates, { days: 28, size: [12, 20], mix: MIX });
    expect(long.length).toBe(28);
    expect(long.slice(0, 8)).toEqual(plan);
    const plantedKeys = long
      .flat()
      .filter((e) => e.variant !== "neutral")
      .map((e) => `${e.suite}|${e.template}`);
    expect(new Set(plantedKeys).size).toBe(plantedKeys.length);
    expect(new Set(long.flat().map((e) => `${e.suite}|${e.template}`)).size).toBeLessThan(long.flat().length);
    for (const d of long) expect(d.filter((e) => e.variant === "hidden").length).toBe(dayKinds(d.length, MIX).hidden);
    // A plan whose planted slots outrun the unplanted templates still throws.
    expect(() =>
      planUser(41, { train1: ["a", "b", "c"] }, { days: 2, size: [3, 3], mix: { hidden: 1, control: 0, neutral: 0 } }),
    ).toThrow(/runs out of unplanted templates/);
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
