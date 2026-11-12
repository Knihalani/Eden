import { describe, expect, test } from "bun:test";
import { RARE_SOURCE_IDS } from "../rare-sources";
import { buildWorld } from "../world";
import { HELDOUT17_LATE } from "./hidden-heldout17";
import { HELDOUT18_ANCHORED, HELDOUT18_LATE } from "./hidden-heldout18";
import {
  heldout19Before,
  HELDOUT19_ANCHORED,
  HELDOUT19_INDIRECT,
  HELDOUT19_NON_ENGLISH,
  HELDOUT19_RARE,
  HELDOUT19_SILENT,
} from "./hidden-heldout19";
import * as dev20a from "./hidden-dev20a";
import * as dev20b from "./hidden-dev20b";
import * as dev20c from "./hidden-dev20c";
import * as dev20d from "./hidden-dev20d";
import {
  heldout20Before,
  HELDOUT20_ANCHORED,
  HELDOUT20_INDIRECT,
  HELDOUT20_NO_OVERLAP,
  HELDOUT20_NON_ENGLISH,
  HELDOUT20_NOW,
  HELDOUT20_QUESTION,
  HELDOUT20_RARE,
  HELDOUT20_SILENT,
} from "./hidden-heldout20";
import { userWorldOf } from "./pi-user";
import { supportsNeutral } from "./neutral";
import { REWORDED } from "./reworded";
import { parseSuites, preparedWorld, SUITE_NAMES, SUITES, UNREAD_BLIND, UNRUN_BLIND } from "./suites";

describe("suite registry", () => {
  test("task ids are unique across a suite's hidden and control variants (runners key results by id)", () => {
    // SUITE_NAMES, not SUITES: a generated split registered by another test file's parseSuites needs local data.
    for (const name of SUITE_NAMES) {
      const plant = SUITES[name]!;
      const ids = (["hidden", "control"] as const).flatMap((v) =>
        plant(preparedWorld(name, 41), 41, v).map((t) => t.id),
      );
      expect({ name, dupes: ids.length - new Set(ids).size }).toEqual({ name, dupes: 0 });
    }
    // Two prepared worlds for each of about 45 suites: under a second alone, past bun's 5 s under parallel load.
  }, 30_000);

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
    // Read by B18 (D802): the funnel now warns that a run naming it was read before.
    expect(UNREAD_BLIND).not.toContain("heldout18");
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

describe("heldout19 (P7, D870): format only, its templates' text is not read here", () => {
  test("40 tasks per variant over the eight areas, neutral plants nothing, rare connectors in every variant", () => {
    for (const seed of [41, 44]) {
      const by = Object.fromEntries(
        (["hidden", "control", "neutral"] as const).map((v) => {
          const world = preparedWorld("heldout19", seed);
          const before = world.items.length;
          const tasks = SUITES.heldout19!(world, seed, v);
          return [v, { tasks, items: world.items.slice(before), sources: Object.keys(world.sources) }];
        }),
      );
      expect([by.hidden!.items.length, by.control!.items.length, by.neutral!.items.length]).toEqual([40, 40, 0]);
      for (const v of ["hidden", "control", "neutral"]) {
        expect(by[v]!.tasks.length).toBe(40);
        expect(RARE_SOURCE_IDS.every((id) => by[v]!.sources.includes(id))).toBe(true);
      }
      const same = (t: { text: string; detail: string; template: string }) => [t.text, t.detail, t.template];
      for (const v of ["control", "neutral"]) {
        expect(by[v]!.tasks.map(same)).toEqual(by.hidden!.tasks.map(same));
        expect(by[v]!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout19-${v}:`))).toBe(true);
      }
      expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout19:`))).toBe(true);
      const names: string[] = by.hidden!.tasks.map((t: { template: string }) => t.template);
      expect(new Set(names).size).toBe(names.length);
      // Refs of the base world's shape, equal in hidden and control, and no marker an agent could read.
      const refs = (v: string) => by[v]!.items.map((it: { ref: string }) => it.ref);
      expect(refs("control")).toEqual(refs("hidden"));
      for (const v of ["hidden", "control"]) {
        for (const it of by[v]!.items as { ref: string; id: string; title: string; meta?: Record<string, string> }[]) {
          expect(it.ref).toMatch(/^[a-z]+-\d+$/);
          const seen = `${it.ref} ${it.id} ${it.title} ${Object.values(it.meta ?? {}).join(" ")}`.toLowerCase();
          expect(names.filter((n) => seen.includes(n))).toEqual([]);
          expect(/heldout|h19|planted|decoy/.test(seen)).toBe(false);
        }
      }
      // The brief's categories (counts only): every list names templates of the suite, at the minimum it asked for.
      const lists: [readonly string[], number][] = [
        [HELDOUT19_ANCHORED, 12],
        [HELDOUT19_RARE, 10],
        [HELDOUT19_SILENT, 8],
        [HELDOUT19_NON_ENGLISH, 6],
        [HELDOUT19_INDIRECT, 16],
      ];
      for (const [list, min] of lists) {
        expect(list.length).toBeGreaterThanOrEqual(min);
        expect(list.every((n) => names.includes(n))).toBe(true);
      }
      const words = (t: { text: string }) => t.text.split(/\s+/).filter(Boolean).length;
      const anchored = by.hidden!.tasks.filter((t: { template: string }) => HELDOUT19_ANCHORED.includes(t.template));
      expect(anchored.every((t: { text: string }) => words(t) <= 12)).toBe(true);
      // Rare-source templates plant in a rare connector in both variants, covering all eight.
      const rareOf = (v: string) =>
        (by[v]!.items as { sourceId: string }[]).filter((_, i) => HELDOUT19_RARE.includes(names[i]!));
      for (const v of ["hidden", "control"])
        expect(rareOf(v).every((it) => RARE_SOURCE_IDS.includes(it.sourceId))).toBe(true);
      expect(new Set(rareOf("hidden").map((it) => it.sourceId)).size).toBe(RARE_SOURCE_IDS.length);
      // Silent edits: one `before` per listed template, the same item (source, kind, title) as the planted one, older.
      const befores = heldout19Before(preparedWorld("heldout19", seed), seed);
      expect(befores.map((b) => b.template).sort()).toEqual([...HELDOUT19_SILENT].sort());
      for (const b of befores) {
        const it = by.hidden!.items[names.indexOf(b.template)] as {
          sourceId: string;
          kind: string;
          title: string;
          updatedAt: number;
        };
        expect([b.before.sourceId, b.before.kind, b.before.title]).toEqual([it.sourceId, it.kind, it.title]);
        expect(b.before.updatedAt).toBeLessThan(it.updatedAt);
      }
    }
    expect(UNRUN_BLIND).toContain("heldout19");
    // Read once by B19 (D1048).
    expect(UNREAD_BLIND).not.toContain("heldout19");
    expect(supportsNeutral("heldout19")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout19");
  });

  test("a harness that skips prepareWorld fails loudly instead of misaligning planted items", () => {
    expect(() => SUITES.heldout19!(buildWorld({ seed: 41_000 }), 41, "hidden")).toThrow(/prepareWorld/);
  });
});

describe("dev20a-d (F8, D1100): tuning suites in the hidden-context format", () => {
  // Each module's lists and `before` function, by the suite's letter.
  const mods: Record<string, Record<string, unknown>> = { dev20a, dev20b, dev20c, dev20d };
  const lists = (x: string, k: string) => mods[`dev20${x}`]![`DEV20${x.toUpperCase()}_${k}`] as readonly string[];
  test.each(["a", "b", "c", "d"])("dev20%s: 40 tasks a variant, the brief's mix, refs and befores", (x) => {
    const suite = `dev20${x}`;
    for (const seed of [41, 44]) {
      const by = Object.fromEntries(
        (["hidden", "control", "neutral"] as const).map((v) => {
          const world = preparedWorld(suite, seed);
          const before = world.items.length;
          const tasks = SUITES[suite]!(world, seed, v);
          return [v, { tasks, items: world.items.slice(before) }];
        }),
      );
      expect([by.hidden!.items.length, by.control!.items.length, by.neutral!.items.length]).toEqual([40, 40, 0]);
      const same = (t: { text: string; detail: string; template: string }) => [t.text, t.detail, t.template];
      for (const v of ["control", "neutral"]) {
        expect(by[v]!.tasks.map(same)).toEqual(by.hidden!.tasks.map(same));
        expect(by[v]!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:${suite}-${v}:`))).toBe(true);
      }
      expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:${suite}:`))).toBe(true);
      const names: string[] = by.hidden!.tasks.map((t: { template: string }) => t.template);
      expect(new Set(names).size).toBe(40);
      const refs = (v: string) => by[v]!.items.map((it: { ref: string }) => it.ref);
      expect(refs("control")).toEqual(refs("hidden"));
      for (const v of ["hidden", "control"]) {
        for (const it of by[v]!.items as { ref: string; id: string; title: string; meta?: Record<string, string> }[]) {
          expect(it.ref).toMatch(/^[a-z]+-\d+$/);
          const seen = `${it.ref} ${it.id} ${it.title} ${Object.values(it.meta ?? {}).join(" ")}`.toLowerCase();
          expect(names.filter((n) => seen.includes(n))).toEqual([]);
          expect(/dev20|heldout|planted|decoy/.test(seen)).toBe(false);
        }
      }
      // The brief's mix (counts from each template's labelled comment, listed by the author).
      const exact: [string, number][] = [
        ["ANCHORED", 14],
        ["RARE", 12],
        ["SILENT", 10],
        ["NON_ENGLISH", 10],
      ];
      for (const [k, n] of exact) expect([k, lists(x, k).length]).toEqual([k, n]);
      for (const k of ["ANCHORED", "RARE", "SILENT", "NON_ENGLISH", "INDIRECT", "QUESTION", "KNOWLEDGE", "NO_OVERLAP"])
        expect(lists(x, k).filter((n) => !names.includes(n))).toEqual([]);
      expect(lists(x, "INDIRECT").length).toBeGreaterThanOrEqual(27);
      expect(lists(x, "QUESTION").length).toBeGreaterThanOrEqual(9);
      expect(lists(x, "QUESTION").every((n) => lists(x, "INDIRECT").includes(n))).toBe(true);
      expect(lists(x, "NO_OVERLAP").length).toBeGreaterThanOrEqual(24);
      expect(lists(x, "KNOWLEDGE").length).toBeGreaterThanOrEqual(5);
      const words = (t: { text: string }) => t.text.split(/\s+/).filter(Boolean).length;
      const anchored = by.hidden!.tasks.filter((t: { template: string }) => lists(x, "ANCHORED").includes(t.template));
      expect(anchored.every((t: { text: string }) => words(t) <= 12)).toBe(true);
      // Rare-source templates plant in a rare connector in both variants, all eight used; no other template does.
      for (const v of ["hidden", "control"]) {
        const items = by[v]!.items as { sourceId: string }[];
        const rare = names.map((n, i) => [lists(x, "RARE").includes(n), RARE_SOURCE_IDS.includes(items[i]!.sourceId)]);
        expect(rare.every(([listed, inRare]) => listed === inRare)).toBe(true);
      }
      const rareUsed = (by.hidden!.items as { sourceId: string }[]).filter((it) =>
        RARE_SOURCE_IDS.includes(it.sourceId),
      );
      expect(new Set(rareUsed.map((it) => it.sourceId)).size).toBe(RARE_SOURCE_IDS.length);
      // Silent edits: one `before` per listed template, the same item (source, kind, title) as the planted one, older.
      const befores = (mods[suite]![`${suite}Before`] as typeof heldout19Before)(preparedWorld(suite, seed), seed);
      expect(befores.map((b) => b.template).sort()).toEqual([...lists(x, "SILENT")].sort());
      for (const b of befores) {
        const it = by.hidden!.items[names.indexOf(b.template)] as {
          sourceId: string;
          kind: string;
          title: string;
          updatedAt: number;
        };
        expect([b.before.sourceId, b.before.kind, b.before.title]).toEqual([it.sourceId, it.kind, it.title]);
        expect(b.before.updatedAt).toBeLessThan(it.updatedAt);
      }
    }
    expect(supportsNeutral(suite)).toBe(true);
    expect(UNRUN_BLIND).not.toContain(suite);
    expect(UNREAD_BLIND).not.toContain(suite);
  });

  test("`--suite dev20` names the four, none in `all` or `train`", () => {
    expect(parseSuites("dev20")).toEqual(["dev20a", "dev20b", "dev20c", "dev20d"]);
    for (const s of ["all", "train"]) expect(parseSuites(s).filter((n) => n.startsWith("dev20"))).toEqual([]);
    expect(() => SUITES.dev20a!(buildWorld({ seed: 41_000 }), 41, "hidden")).toThrow(/prepareWorld/);
  });
});

describe("heldout20 (F4, D1080): format only, its templates' text is not read here", () => {
  test("48 tasks per variant over the eight areas, neutral plants nothing, its own present, rare connectors", () => {
    for (const seed of [41, 44]) {
      const by = Object.fromEntries(
        (["hidden", "control", "neutral"] as const).map((v) => {
          const world = preparedWorld("heldout20", seed);
          expect(world.now).toBe(HELDOUT20_NOW);
          const before = world.items.length;
          const tasks = SUITES.heldout20!(world, seed, v);
          return [v, { tasks, items: world.items.slice(before), sources: Object.keys(world.sources) }];
        }),
      );
      expect([by.hidden!.items.length, by.control!.items.length, by.neutral!.items.length]).toEqual([48, 48, 0]);
      for (const v of ["hidden", "control", "neutral"]) {
        expect(by[v]!.tasks.length).toBe(48);
        expect(RARE_SOURCE_IDS.every((id) => by[v]!.sources.includes(id))).toBe(true);
      }
      const same = (t: { text: string; detail: string; template: string }) => [t.text, t.detail, t.template];
      for (const v of ["control", "neutral"]) {
        expect(by[v]!.tasks.map(same)).toEqual(by.hidden!.tasks.map(same));
        expect(by[v]!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout20-${v}:`))).toBe(true);
      }
      expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith(`w${seed}:heldout20:`))).toBe(true);
      const names: string[] = by.hidden!.tasks.map((t: { template: string }) => t.template);
      expect(new Set(names).size).toBe(names.length);
      // Refs of the base world's shape, equal in hidden and control, and no marker an agent could read.
      const refs = (v: string) => by[v]!.items.map((it: { ref: string }) => it.ref);
      expect(refs("control")).toEqual(refs("hidden"));
      for (const v of ["hidden", "control"]) {
        for (const it of by[v]!.items as { ref: string; id: string; title: string; meta?: Record<string, string> }[]) {
          expect(it.ref).toMatch(/^[a-z]+-\d+$/);
          const seen = `${it.ref} ${it.id} ${it.title} ${Object.values(it.meta ?? {}).join(" ")}`.toLowerCase();
          expect(names.filter((n) => seen.includes(n))).toEqual([]);
          expect(/heldout|h20|planted|decoy/.test(seen)).toBe(false);
        }
        // Nothing planted after the suite's present.
        expect((by[v]!.items as { updatedAt: number }[]).every((it) => it.updatedAt <= HELDOUT20_NOW)).toBe(true);
      }
      // The brief's categories (counts only): every list names templates of the suite, at about the asked count.
      const lists: [readonly string[], number][] = [
        [HELDOUT20_ANCHORED, 14],
        [HELDOUT20_RARE, 12],
        [HELDOUT20_SILENT, 10],
        [HELDOUT20_NON_ENGLISH, 12],
        [HELDOUT20_QUESTION, 10],
        [HELDOUT20_INDIRECT, 16],
        [HELDOUT20_NO_OVERLAP, 24],
      ];
      for (const [list, min] of lists) {
        expect(list.length).toBeGreaterThanOrEqual(min);
        expect(list.every((n) => names.includes(n))).toBe(true);
        expect(new Set(list).size).toBe(list.length);
      }
      expect(HELDOUT20_QUESTION.filter((n) => HELDOUT20_INDIRECT.includes(n))).toEqual([]);
      // Rare-source templates plant in a rare connector in both variants, covering all eight; the others do not.
      for (const v of ["hidden", "control"]) {
        const items = by[v]!.items as { sourceId: string }[];
        names.forEach((n, i) => expect(RARE_SOURCE_IDS.includes(items[i]!.sourceId)).toBe(HELDOUT20_RARE.includes(n)));
      }
      const rareHidden = (by.hidden!.items as { sourceId: string }[]).filter((_, i) =>
        HELDOUT20_RARE.includes(names[i]!),
      );
      expect(new Set(rareHidden.map((it) => it.sourceId)).size).toBe(RARE_SOURCE_IDS.length);
      // Silent edits: one `before` per listed template, the same item (source, kind, title) as the planted one, older.
      const befores = heldout20Before(preparedWorld("heldout20", seed), seed);
      expect(befores.map((b) => b.template).sort()).toEqual([...HELDOUT20_SILENT].sort());
      for (const b of befores) {
        const it = by.hidden!.items[names.indexOf(b.template)] as {
          sourceId: string;
          kind: string;
          title: string;
          updatedAt: number;
        };
        expect([b.before.sourceId, b.before.kind, b.before.title]).toEqual([it.sourceId, it.kind, it.title]);
        expect(b.before.updatedAt).toBeLessThan(it.updatedAt);
      }
    }
    expect(UNRUN_BLIND).toContain("heldout20");
    // Read once by the F-wave final (f-wave-final.md).
    expect(UNREAD_BLIND).not.toContain("heldout20");
    expect(supportsNeutral("heldout20")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout20");
  });

  test("a harness that skips prepareWorld fails loudly; its own clock refuses a user mixed with another suite", () => {
    expect(() => SUITES.heldout20!(buildWorld({ seed: 41_000 }), 41, "hidden")).toThrow(/prepareWorld/);
    const mixed = [
      [
        { suite: "heldout20", template: "x", variant: "hidden" },
        { suite: "train1", template: "y", variant: "hidden" },
      ],
    ];
    expect(() => userWorldOf(41, mixed as never)).toThrow(/own world time/);
  });
});

describe("longtail (P7, D873)", () => {
  test("24 tasks, three per area, every planted item in a rare connector, neutral adds nothing", () => {
    for (const seed of [41, 44]) {
      const built = (["hidden", "control", "neutral"] as const).map((v) => {
        const world = preparedWorld("longtail", seed);
        const before = world.items.length;
        return { v, tasks: SUITES.longtail!(world, seed, v), items: world.items.slice(before) };
      });
      const [hidden, control, neutral] = built;
      expect([hidden!.items.length, control!.items.length, neutral!.items.length]).toEqual([24, 24, 0]);
      for (const b of [hidden!, control!]) {
        expect(b.items.every((it) => RARE_SOURCE_IDS.includes(it.sourceId))).toBe(true);
        expect(b.tasks.every((t) => t.id.startsWith(`w${seed}:longtail${b.v === "hidden" ? "" : `-${b.v}`}:`))).toBe(
          true,
        );
      }
      // The same connector in hidden and control, per template; all eight connectors used.
      expect(control!.items.map((it) => it.sourceId)).toEqual(hidden!.items.map((it) => it.sourceId));
      expect(new Set(hidden!.items.map((it) => it.sourceId)).size).toBe(RARE_SOURCE_IDS.length);
      expect(new Set(hidden!.tasks.map((t) => t.template)).size).toBe(24);
      for (const b of [control!, neutral!])
        expect(b.tasks.map((t) => t.text)).toEqual(hidden!.tasks.map((t) => t.text));
    }
    expect(supportsNeutral("longtail")).toBe(true);
    expect(parseSuites("all")).not.toContain("longtail");
    expect(parseSuites("train")).not.toContain("longtail");
  });
});

describe("reworded train (P7, D871)", () => {
  test("train1r-6r: train's worlds and tasks, every request reworded, six non-English a suite, ids `<suite>r`", () => {
    expect(parseSuites("reworded")).toEqual(["train1r", "train2r", "train3r", "train4r", "train5r", "train6r"]);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const base = `train${n}`;
      expect(Object.values(REWORDED[base]!).filter((w) => w.lang).length).toBe(6);
      for (let seed = 41; seed <= 52; seed++) {
        for (const v of ["hidden", "control", "neutral"] as const) {
          const a = preparedWorld(base, seed);
          const b = preparedWorld(`${base}r`, seed);
          const orig = SUITES[base]!(a, seed, v);
          const re = SUITES[`${base}r`]!(b, seed, v);
          // The same items planted, and the slot cleared from the original request.
          expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id));
          expect(re.map((t) => [t.template, t.detail, t.slotText])).toEqual(
            orig.map((t) => [t.template, t.detail, t.text]),
          );
          // No capture left unfilled: a `$` digit only where the original has one ("$40k").
          const left = (t: { text: string }) => t.text.match(/\$\d/g)?.length ?? 0;
          expect(re.every((t, i) => t.text !== orig[i]!.text && left(t) <= left(orig[i]!))).toBe(true);
          expect(re.map((t) => t.id)).toEqual(orig.map((t) => t.id.replace(`:${base}`, `:${base}r`)));
        }
      }
    }
    expect(parseSuites("all")).not.toContain("train1r");
  }, 60_000);
});
