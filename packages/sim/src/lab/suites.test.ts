import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { HELDOUT17_LATE } from "./hidden-heldout17";
import { HELDOUT18_ANCHORED, HELDOUT18_LATE } from "./hidden-heldout18";
import { supportsNeutral } from "./neutral";
import { parseSuites, SUITE_NAMES, SUITES, UNREAD_BLIND, UNRUN_BLIND } from "./suites";

describe("suite registry", () => {
  test("task ids are unique across a suite's hidden and control variants (runners key results by id)", () => {
    for (const [name, plant] of Object.entries(SUITES)) {
      const ids = (["hidden", "control"] as const).flatMap((v) =>
        plant(buildWorld({ seed: 41_000 }), 41, v).map((t) => t.id),
      );
      expect({ name, dupes: ids.length - new Set(ids).size }).toEqual({ name, dupes: 0 });
    }
  });

  test("every blind suite is registered, so the blind run can name it (heldout5-9)", () => {
    for (const n of [5, 6, 7, 8, 9]) expect(SUITE_NAMES).toContain(`heldout${n}`);
    expect(parseSuites("heldout9")).toEqual(["heldout9"]);
    // Neither `all` nor `heldout-all` runs a blind suite that has never been run: a tuning command with `--suite all`
    // must not spend it. It is only ever named on purpose, alone or in a list.
    expect(parseSuites("all")).not.toContain("heldout9");
    expect(parseSuites("all")).toContain("heldout8");
    expect(parseSuites("heldout-all")).not.toContain("heldout9");
    expect(parseSuites("all,heldout9")).toContain("heldout9");
  });

  test("heldout10 plants 32 tasks per variant, keeps the request text, and is left out of `all`", () => {
    const [hidden, control] = (["hidden", "control"] as const).map((v) =>
      SUITES.heldout10!(buildWorld({ seed: 41_000 }), 41, v),
    );
    expect(hidden!.length).toBe(32);
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(hidden!.every((t) => t.id.startsWith("w41:heldout10:"))).toBe(true);
    expect(control!.every((t) => t.id.startsWith("w41:heldout10-control:"))).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout10");
  });

  test("heldout11 plants 32 tasks per variant, keeps the request text, and is left out of `all`", () => {
    const [hidden, control] = (["hidden", "control"] as const).map((v) =>
      SUITES.heldout11!(buildWorld({ seed: 41_000 }), 41, v),
    );
    expect(hidden!.length).toBe(32);
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(hidden!.every((t) => t.id.startsWith("w41:heldout11:"))).toBe(true);
    expect(control!.every((t) => t.id.startsWith("w41:heldout11-control:"))).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout11");
  });

  test("heldout12 plants 32 tasks per variant, keeps the request text, and is left out of `all`", () => {
    const [hidden, control] = (["hidden", "control"] as const).map((v) =>
      SUITES.heldout12!(buildWorld({ seed: 41_000 }), 41, v),
    );
    expect(hidden!.length).toBe(32);
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(hidden!.every((t) => t.id.startsWith("w41:heldout12:"))).toBe(true);
    expect(control!.every((t) => t.id.startsWith("w41:heldout12-control:"))).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout12");
  });

  test("heldout9 plants tasks under its own name (counts and ids only: its templates are not read here)", () => {
    for (const v of ["hidden", "control"] as const) {
      const tasks = SUITES.heldout9!(buildWorld({ seed: 41_000 }), 41, v);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((t) => t.id.includes("heldout9"))).toBe(true);
    }
  });

  test("heldout15 builds 32 tasks per variant with neutral, unrun and out of `all` (counts and ids only)", () => {
    const by = Object.fromEntries(
      (["hidden", "control", "neutral"] as const).map((v) => {
        const world = buildWorld({ seed: 41_000 });
        const before = world.items.length;
        const tasks = SUITES.heldout15!(world, 41, v);
        return [v, { tasks, planted: world.items.length - before }];
      }),
    );
    for (const v of ["hidden", "control", "neutral"]) expect(by[v]!.tasks.length).toBe(32);
    expect([by.hidden!.planted, by.control!.planted, by.neutral!.planted]).toEqual([32, 32, 0]);
    expect(by.neutral!.tasks.map((t: { text: string }) => t.text)).toEqual(
      by.hidden!.tasks.map((t: { text: string }) => t.text),
    );
    expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith("w41:heldout15:"))).toBe(true);
    expect(by.neutral!.tasks.every((t: { id: string }) => t.id.startsWith("w41:heldout15-neutral:"))).toBe(true);
    expect(UNRUN_BLIND).toContain("heldout15");
    expect(supportsNeutral("heldout15")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout15");
  });

  test("train suites build neutral: the control's tasks under -neutral ids, the world left unplanted (CL5)", () => {
    for (const name of parseSuites("train")) {
      const plain = buildWorld({ seed: 42_000 });
      const world = buildWorld({ seed: 42_000 });
      const neutral = SUITES[name]!(world, 42, "neutral");
      const control = SUITES[name]!(buildWorld({ seed: 42_000 }), 42, "control");
      const hidden = SUITES[name]!(buildWorld({ seed: 42_000 }), 42, "hidden");
      expect(world.items).toEqual(plain.items);
      expect(world.people).toEqual(plain.people);
      expect(neutral.length).toBe(32);
      expect(neutral.map((t) => [t.text, t.detail, t.template])).toEqual(
        control.map((t) => [t.text, t.detail, t.template]),
      );
      expect(neutral.map((t) => t.text)).toEqual(hidden.map((t) => t.text));
      expect(neutral.every((t) => t.id.startsWith(`w42:${name}-neutral:`))).toBe(true);
      expect(supportsNeutral(name)).toBe(true);
    }
  });

  test("heldout16 builds 32 tasks per variant with neutral, unrun and out of `all` (counts and ids only)", () => {
    for (const seed of [41, 44]) {
      const by = Object.fromEntries(
        (["hidden", "control", "neutral"] as const).map((v) => {
          const world = buildWorld({ seed: seed * 1_000 });
          const before = world.items.length;
          const tasks = SUITES.heldout16!(world, seed, v);
          return [v, { tasks, planted: world.items.length - before }];
        }),
      );
      expect([by.hidden!.planted, by.control!.planted, by.neutral!.planted]).toEqual([32, 32, 0]);
      for (const v of ["control", "neutral"]) {
        expect(by[v]!.tasks.map((t: { text: string }) => t.text)).toEqual(
          by.hidden!.tasks.map((t: { text: string }) => t.text),
        );
        expect(by[v]!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout16-${v}:`))).toBe(true);
      }
      expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout16:`))).toBe(true);
    }
    expect(UNRUN_BLIND).toContain("heldout16");
    expect(supportsNeutral("heldout16")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout16");
  });

  // D350 (docs/research/a19-heldout17.md): counts, ids and refs only; its templates' text is not read here.
  test("heldout17 builds 32 tasks per variant with neutral, unrun, out of `all`, and its refs name no template", () => {
    for (const seed of [41, 44]) {
      const by = Object.fromEntries(
        (["hidden", "control", "neutral"] as const).map((v) => {
          const world = buildWorld({ seed: seed * 1_000 });
          const before = world.items.length;
          const tasks = SUITES.heldout17!(world, seed, v);
          return [v, { tasks, items: world.items.slice(before) }];
        }),
      );
      expect([by.hidden!.items.length, by.control!.items.length, by.neutral!.items.length]).toEqual([32, 32, 0]);
      const same = (t: { text: string; detail: string; template: string }) => [t.text, t.detail, t.template];
      for (const v of ["control", "neutral"]) {
        expect(by[v]!.tasks.map(same)).toEqual(by.hidden!.tasks.map(same));
        expect(by[v]!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout17-${v}:`))).toBe(true);
      }
      expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout17:`))).toBe(true);
      // The tools arm sees refs and ids (A5/CL5 review): the base world's `<kind>-<index>` shape, the same in hidden
      // and control, and no template name, suite name or "planted" marker in an item's ref, id, title or meta.
      const names: string[] = by.hidden!.tasks.map((t: { template: string }) => t.template);
      const refs = (v: string) => by[v]!.items.map((it: { ref: string }) => it.ref);
      expect(refs("control")).toEqual(refs("hidden"));
      for (const v of ["hidden", "control"]) {
        for (const it of by[v]!.items as { ref: string; id: string; title: string }[]) {
          expect(it.ref).toMatch(/^[a-z]+-\d+$/);
          const meta = Object.values((it as { meta?: Record<string, string> }).meta ?? {}).join(" ");
          const seen = `${it.ref} ${it.id} ${it.title} ${meta}`.toLowerCase();
          expect(names.filter((n) => seen.includes(n))).toEqual([]);
          expect(/heldout|h17|planted|decoy/.test(seen)).toBe(false);
        }
      }
      // Eight late-arrival templates (one per life area), each a template of the suite (`pi-ab --late --templates`).
      expect(HELDOUT17_LATE.length).toBe(8);
      expect(HELDOUT17_LATE.every((n) => names.includes(n))).toBe(true);
    }
    expect(UNRUN_BLIND).toContain("heldout17");
    // Read by A29 (D399): the funnel now warns that a run naming it was read before.
    expect(UNREAD_BLIND).not.toContain("heldout17");
    expect(supportsNeutral("heldout17")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout17");
  });
  // D465 (docs/research/m6-heldout18.md): counts, ids and refs only; its templates' text is not read here.
  test("heldout18 builds 32 tasks per variant with neutral, unread, out of `all`, and its refs name no template", () => {
    for (const seed of [41, 44]) {
      const by = Object.fromEntries(
        (["hidden", "control", "neutral"] as const).map((v) => {
          const world = buildWorld({ seed: seed * 1_000 });
          const before = world.items.length;
          const tasks = SUITES.heldout18!(world, seed, v);
          return [v, { tasks, items: world.items.slice(before) }];
        }),
      );
      expect([by.hidden!.items.length, by.control!.items.length, by.neutral!.items.length]).toEqual([32, 32, 0]);
      const same = (t: { text: string; detail: string; template: string }) => [t.text, t.detail, t.template];
      for (const v of ["control", "neutral"]) {
        expect(by[v]!.tasks.map(same)).toEqual(by.hidden!.tasks.map(same));
        expect(by[v]!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout18-${v}:`))).toBe(true);
      }
      expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout18:`))).toBe(true);
      // Template names and task ids are unique, so a per-template read (or a --templates filter) names one task.
      const names: string[] = by.hidden!.tasks.map((t: { template: string }) => t.template);
      expect(new Set(names).size).toBe(names.length);
      for (const v of ["hidden", "control", "neutral"]) {
        const ids = by[v]!.tasks.map((t: { id: string }) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
      // As heldout17: refs of the base world's shape, equal in hidden and control, and no marker an agent could read.
      const refs = (v: string) => by[v]!.items.map((it: { ref: string }) => it.ref);
      expect(refs("control")).toEqual(refs("hidden"));
      for (const v of ["hidden", "control"]) {
        for (const it of by[v]!.items as { ref: string; id: string; title: string }[]) {
          expect(it.ref).toMatch(/^[a-z]+-\d+$/);
          const meta = Object.values((it as { meta?: Record<string, string> }).meta ?? {}).join(" ");
          const seen = `${it.ref} ${it.id} ${it.title} ${meta}`.toLowerCase();
          expect(names.filter((n) => seen.includes(n))).toEqual([]);
          expect(/heldout|h18|planted|decoy/.test(seen)).toBe(false);
        }
      }
      // Eight late-arrival templates and at least twelve short anchored requests, all templates of the suite.
      expect(HELDOUT18_LATE.length).toBe(8);
      expect(HELDOUT18_LATE.every((n) => names.includes(n))).toBe(true);
      expect(HELDOUT18_ANCHORED.length).toBeGreaterThanOrEqual(12);
      expect(HELDOUT18_ANCHORED.every((n) => names.includes(n))).toBe(true);
      const words = (t: { text: string }) => t.text.split(/\s+/).filter(Boolean).length;
      const anchored = by.hidden!.tasks.filter((t: { template: string }) => HELDOUT18_ANCHORED.includes(t.template));
      expect(anchored.every((t: { text: string }) => words(t) <= 12)).toBe(true);
    }
    expect(UNRUN_BLIND).toContain("heldout18");
    // Unread (D465): the funnel calls a run naming it the blind read rather than "read before".
    expect(UNREAD_BLIND).toEqual(["heldout18"]);
    expect(supportsNeutral("heldout18")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout18");
  });

  test("the registry's suite names are unique and every UNRUN_BLIND and UNREAD_BLIND name is a suite", () => {
    expect(new Set(SUITE_NAMES).size).toBe(SUITE_NAMES.length);
    expect(new Set(UNRUN_BLIND).size).toBe(UNRUN_BLIND.length);
    expect(UNRUN_BLIND.every((n) => SUITE_NAMES.includes(n))).toBe(true);
    expect(UNREAD_BLIND.every((n) => UNRUN_BLIND.includes(n))).toBe(true);
  });
});
