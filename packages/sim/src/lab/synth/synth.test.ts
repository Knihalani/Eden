import { describe, expect, test } from "bun:test";
import { buildWorld } from "../../world";
import { parseSuites, SUITES } from "../suites";
import { supportsNeutral } from "../neutral";
import { mergeObjects, parseJson, repairEarlyClose } from "./jobs";
import { pairsOf } from "./labels";
import { jaccard, leaks, splitOfCluster, wordSet } from "./qc";
import { checkWorld, validateWorld, wrongWeekdays, type SynthWorld } from "./schema";
import { readWorlds, SAMPLE_PATH } from "./suite";

const sample = () => readWorlds(SAMPLE_PATH);

describe("synth schema (D880)", () => {
  test("the committed sample validates: schema, references, timing, weekdays", () => {
    const ws = sample();
    expect(ws.length).toBeGreaterThanOrEqual(3);
    for (const w of ws) expect({ id: w.id, problems: validateWorld(w).problems }).toEqual({ id: w.id, problems: [] });
  });

  test("checkWorld catches a dangling fact, an item claimed twice, and a silent fact that revises nothing", () => {
    const w = structuredClone(sample()[0]!) as SynthWorld;
    const [a, b] = w.tasks;
    a!.fact = "i99999";
    b!.neutrals = [...b!.neutrals, b!.decoy];
    const silent = w.tasks.find((t, i) => i > 1 && t.timing === "static")!;
    silent.timing = "silent";
    const p = checkWorld(w).join("\n");
    expect(p).toContain(`${a!.id}: no item i99999`);
    expect(p).toContain("already belongs to");
    expect(p).toContain(`${silent.id}: silent fact does not revise the decoy`);
  });

  test("wrongWeekdays reads the date against the calendar", () => {
    expect(wrongWeekdays("Tuesday 27 October 2026 at 9")).toEqual([]);
    expect(wrongWeekdays("Thu 29 Oct")).toEqual([]);
    expect(wrongWeekdays("Monday 29 October 2026")).toEqual(["Monday 29 October 2026"]);
    expect(wrongWeekdays("Fri 5 Nov")).toEqual(["Fri 5 Nov"]);
  });
});

describe("synth labels come from construction (D881)", () => {
  test("each request has exactly one `changes` item, its own fact; its decoy and neutrals are `clear`", () => {
    for (const w of sample()) {
      const pairs = pairsOf(w);
      expect(pairs.length).toBe(w.tasks.reduce((n, t) => n + t.requests.length, 0) * w.items.length);
      for (const t of w.tasks)
        for (const r of t.requests) {
          const mine = pairs.filter((p) => p.request === r.id);
          expect(mine.filter((p) => p.label === "changes").map((p) => p.item)).toEqual([t.fact]);
          expect(
            mine
              .filter((p) => p.label === "clear")
              .map((p) => p.item)
              .sort(),
          ).toEqual([t.decoy, ...t.neutrals].sort());
        }
    }
  });

  test("visibility: an item is visible from its own time; a silent change's earlier revision only until the edit", () => {
    for (const w of sample()) {
      const at = new Map(w.items.map((i) => [i.id, i.at]));
      for (const p of pairsOf(w)) {
        const r = w.tasks.flatMap((t) => t.requests).find((x) => x.id === p.request)!;
        const edit = w.items.find((i) => i.revisionOf === p.item);
        expect(p.visible).toBe(at.get(p.item)! <= r.at && (!edit || edit.at > r.at));
      }
    }
  });
});

describe("synth reply parsing", () => {
  test("repairs an early close and stray closers, and merges an answer split over two objects", () => {
    expect(parseJson('{"a": [1], "b": {"c": 2}}}')).toEqual({ a: [1], b: { c: 2 } });
    expect(JSON.parse(repairEarlyClose('{"p": [1]}, "items": [2]}'))).toEqual({ p: [1], items: [2] });
    expect(parseJson('{"p": {"x": "}, "}, "q": [1]}, "items": [2]}')).toEqual({ p: { x: "}, " }, q: [1], items: [2] });
    expect(mergeObjects('{"persona": {"f": 1}, "people": [1]}\n\n{"persona": null, "items": [3]}')).toEqual({
      persona: { f: 1 },
      people: [1],
      items: [3],
    });
    expect(() => parseJson("I can't build this one as specified.")).toThrow();
  });
});

describe("synth QC (D882)", () => {
  test("similarity, leak tokens and the cluster split are deterministic and behave at the edges", () => {
    expect(jaccard(wordSet("book the dentist"), wordSet("book the dentist"))).toBe(1);
    expect(jaccard(wordSet(""), wordSet("x"))).toBe(0);
    // A reference only the fact holds is a leak; a name of the world's people is not.
    expect(leaks("Pay INV-4471 today", "Invoice INV-4471 was paid", ["Invoice paid"])).toEqual(["INV-4471"]);
    expect(leaks("Email Priya", "Priya left", ["other"], new Set(["Priya"]))).toEqual([]);
    expect(splitOfCluster("f-work-x")).toBe(splitOfCluster("f-work-x"));
    const split = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((c) => splitOfCluster(`f-${c}`));
    expect(split.every((s) => ["train", "val", "test"].includes(s))).toBe(true);
  });
});

describe("the synth suite family (D884)", () => {
  test("synth-sample plants one item a task at the end, keeps the world's length otherwise, and renames the user", () => {
    const base = buildWorld({ seed: 41_000 }).items.length;
    const out = (["hidden", "control", "neutral"] as const).map((v) => {
      const world = buildWorld({ seed: 41_000 });
      const tasks = SUITES["synth-sample"]!(world, 41, v);
      return { world, tasks };
    });
    const [h, c, n] = out;
    expect(h!.world.items.length).toBe(base + h!.tasks.length);
    expect(c!.world.items.length).toBe(base + c!.tasks.length);
    expect(n!.world.items.length).toBe(base);
    expect(c!.tasks.map((t) => t.text)).toEqual(h!.tasks.map((t) => t.text));
    expect(n!.tasks.map((t) => t.text)).toEqual(h!.tasks.map((t) => t.text));
    expect(h!.tasks.every((t) => t.id.startsWith("w41:synth-sample:"))).toBe(true);
    expect(n!.tasks.every((t) => t.id.startsWith("w41:synth-sample-neutral:"))).toBe(true);
    // The planted items are the fact (hidden) and decoy (control), in task order, and differ.
    const ph = h!.world.items.slice(base);
    const pc = c!.world.items.slice(base);
    expect(ph.map((i) => i.text)).not.toEqual(pc.map((i) => i.text));
    // The persona is the base world's user, and refs name no template.
    const w = sample()[41 % sample().length]!;
    const text = h!.world.items.map((i) => `${i.title}\n${i.text}`).join("\n");
    expect(text.includes(w.persona.email)).toBe(false);
    expect(text).toContain(h!.world.user.email);
    for (const it of ph) expect(it.ref).toMatch(/^[a-z]+-\d+$/);
    // Every rare source the world uses is served.
    for (const id of Object.keys(w.sources)) expect(h!.world.sources[id]).toBeTruthy();
  });

  test("synth names parse: splits and files register on use, `@K` plants K worlds a seed, none is in `all`", () => {
    expect(parseSuites("all").some((s) => s.startsWith("synth"))).toBe(false);
    expect(parseSuites("synth")).toEqual(["synth-train", "synth-val"]);
    expect(parseSuites(`synth:${SAMPLE_PATH}`)).toEqual([`synth:${SAMPLE_PATH}`]);
    expect(supportsNeutral("synth-val")).toBe(true);
    parseSuites("synth-sample@3");
    const tasks = SUITES["synth-sample@3"]!(buildWorld({ seed: 42_000 }), 42, "hidden");
    expect(new Set(tasks.map((t) => t.template.split("-t")[0])).size).toBe(3);
    expect(() => parseSuites("synth-nope")).toThrow(/unknown suite/);
  });
});
