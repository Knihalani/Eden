/**
 * LOGO rows (M14, D1021): one line per task, in one shape for every generator, so the leave-one-generator-out
 * harness (`packages/sim/lab/m14/logo.py`) can train on some sources and test on another. LAB ONLY.
 *
 *   {src, group, world, task, archetype, lang, requests: [text], fact: Item, decoy: Item, neutrals: [Item],
 *    others: [Item]}        Item = {source, title, text}
 *
 * `group` is the scenario template (a sim template or a synth family), the unit a within-source split keeps whole.
 * `others` are items of the same world that belong to no part of the task (background and other tasks' items), the
 * `unrelated` label of `labels.ts`. Every title and text passes the engine's `sanitizeItem`, as the cache stores it.
 *
 *   bun packages/sim/src/lab/m14/logo-export.ts synth FILE --src NAME --out OUT
 *   bun packages/sim/src/lab/m14/logo-export.ts sim --seeds 100-139 --suites train1,...,train6 --out OUT
 *
 * The sim side reads the train suites only (m3-export refuses anything else); held-out suites never enter.
 */
import { writeFileSync } from "node:fs";
import { sanitizeItem } from "@eden/engine";
import { Rng } from "../../rng";
import { exportSeed, parseSeeds } from "../m3-export";
import { parseSuites } from "../suites";
import type { SynthItem, SynthWorld } from "../synth/schema";
import { readWorlds } from "../synth/suite";

export interface LogoItem {
  source: string;
  title: string;
  text: string;
}
export interface LogoRow {
  src: string;
  group: string;
  world: string;
  task: string;
  archetype: string;
  lang: string;
  requests: string[];
  fact: LogoItem;
  decoy: LogoItem;
  neutrals: LogoItem[];
  others: LogoItem[];
}

const OTHERS = 24;
export const cleanItem = (source: string, title: string, text: string): LogoItem => {
  const it = sanitizeItem({ id: "x", ref: "x", source, kind: "doc", title, text, updatedAt: 0 } as never);
  return { source, title: it.title, text: it.text.slice(0, 2_000) };
};

/** A synth world (M2, G2, G3: one schema) as LOGO rows. */
export function synthRows(w: SynthWorld, src: string): LogoRow[] {
  const items = new Map(w.items.map((i) => [i.id, i]));
  const own = (i: SynthItem) => cleanItem(i.source, i.title, i.text);
  const taken = new Set(w.tasks.flatMap((t) => [t.fact, t.decoy, ...t.neutrals]));
  const rng = new Rng(w.items.length * 7919 + w.tasks.length);
  return w.tasks.map((t) => {
    const mine = new Set([t.fact, t.decoy, ...t.neutrals]);
    // Unrelated: background first (no task owns it), then other tasks' items, as labels.ts calls both unrelated.
    const bg = w.items.filter((i) => !taken.has(i.id));
    const otherTasks = w.items.filter((i) => taken.has(i.id) && !mine.has(i.id));
    const others = [...rng.sample(bg, Math.min(bg.length, OTHERS - 6)), ...rng.sample(otherTasks, 6)].slice(0, OTHERS);
    return {
      src,
      group: t.family,
      world: w.id,
      task: t.id,
      archetype: t.archetype,
      lang: t.requests[0]?.lang ?? "en",
      requests: t.requests.map((r) => r.text),
      fact: own(items.get(t.fact)!),
      decoy: own(items.get(t.decoy)!),
      neutrals: t.neutrals.map((n) => own(items.get(n)!)),
      others: others.map(own),
    };
  });
}

/** The sim's hand-written families (train suites) for the named seeds: one row per planted template. */
export function simRows(seeds: number[], suites: string[], src = "sim"): LogoRow[] {
  const out: LogoRow[] = [];
  for (const seed of seeds) {
    const s = exportSeed(seed, suites);
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const planted = new Set(s.tasks.flatMap((t) => [t.pos, t.decoy]));
    const pool = s.items.filter((i) => !planted.has(i.id));
    const rng = new Rng(seed);
    for (const t of s.tasks) {
      const fact = byId.get(t.pos);
      const decoy = byId.get(t.decoy);
      if (!fact || !decoy) continue;
      const item = (i: { id: string; title: string; text: string }): LogoItem => ({
        source: i.id.split(":")[0] ?? "sim",
        title: i.title,
        text: i.text,
      });
      out.push({
        src,
        group: `${t.suite}/${t.template}`,
        world: `sim-${seed}`,
        task: `${t.suite}/${t.template}`,
        archetype: "",
        lang: "en",
        requests: [t.request],
        fact: item(fact),
        decoy: item(decoy),
        neutrals: [],
        others: rng.sample(pool, OTHERS).map(item),
      });
    }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string, d = "") => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1]! : d;
  };
  const out = opt("out");
  if (!out) throw new Error("--out FILE");
  let rows: LogoRow[];
  if (argv[0] === "synth") rows = readWorlds(argv[1]!).flatMap((w) => synthRows(w, opt("src", "synth")));
  else if (argv[0] === "sim") {
    const suites = parseSuites(opt("suites", "train"));
    if (suites.some((s) => !s.startsWith("train"))) throw new Error("logo-export: train suites only");
    rows = simRows(parseSeeds(opt("seeds", "100-139")), suites, opt("src", "sim"));
  } else throw new Error("usage: logo-export.ts synth FILE --src NAME --out OUT | sim --seeds A-B --out OUT");
  writeFileSync(out, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  console.log(`${rows.length} rows (${new Set(rows.map((r) => r.group)).size} groups) → ${out}`);
}
