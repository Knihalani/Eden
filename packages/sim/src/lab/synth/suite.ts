/**
 * The `synth` suite family (D884), LAB ONLY: generated worlds run as hidden-context suites, the way train is used, so
 * funnel, days-calls and pi-ab run on them unchanged. A synth suite is one file of synth worlds; seed `s` plants world
 * `s mod N` into the sim's base world for that seed:
 *
 * - the synth user is renamed to the base world's user (name, first name, email), so the persona is Robin's world;
 * - every synth item that is not a task's fact or decoy (background and neutral items) overwrites one of the base
 *   world's noise items in place, keeping its ref, so `world.items` keeps its length and the planted items stay the
 *   last ones, one a task, in task order (what hidden-funnel and ab-common read);
 * - each task then plants its fact (`hidden`), its decoy (`control`) or nothing (`neutral`), and rare sources the
 *   world uses are added to `world.sources` so the sim serves them.
 *
 * The request is one of the task's English phrasings (not a follow-up), rotated by seed and task so a run sees every
 * style; hidden, control and neutral share it. Late and multi-day facts are planted up front, as `--days` does for
 * heldout17's late templates; their timing is the dataset's (labels.ts `visible`), not the lab's.
 */
import { existsSync, readFileSync } from "node:fs";
import { itemId } from "@eden/protocol";
import type { World, WorldItem } from "../../world";
import type { HiddenTask } from "../hidden-context";
import { WorldSchema, type SynthItem, type SynthWorld } from "./schema";

type Variant = "hidden" | "control" | "neutral";

/** Reads a worlds file (JSON lines), each parsed by the schema: a malformed world is an error, not a skip. */
export function readWorlds(path: string): SynthWorld[] {
  if (!existsSync(path))
    throw new Error(
      `synth: no worlds file at ${path} (the dataset lives on the Modal volume eden-synth: ` +
        "`modal volume get eden-synth worlds/<split>.jsonl .local/m2/synth/worlds/`, see packages/sim/lab/synth/README.md)",
    );
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = WorldSchema.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`synth: ${path} line ${i + 1}: ${r.error.issues[0]?.message}`);
      return r.data;
    });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The synth persona's name and email, renamed to the base world's user. */
export function renamer(w: SynthWorld, user: World["user"]): (s: string) => string {
  const pairs: [RegExp, string][] = [
    [new RegExp(esc(w.persona.email), "gi"), user.email],
    [new RegExp(`\\b${esc(w.persona.first)}\\s+${esc(w.persona.last)}\\b`, "g"), user.full],
    [new RegExp(`\\b${esc(w.persona.first)}\\b`, "g"), user.first],
  ];
  return (s) => pairs.reduce((t, [re, to]) => t.replace(re, to), s);
}

function toWorldItem(it: SynthItem, ref: string, now: number, rename: (s: string) => string): WorldItem {
  return {
    id: itemId(it.source, ref),
    sourceId: it.source,
    ref,
    title: rename(it.title),
    text: rename(it.text),
    // A late or multi-day item (after the sim's present) is planted up front, a minute before it.
    updatedAt: Math.min(it.at, now - 60_000),
    kind: it.kind,
    facts: [],
    noise: false,
    ...(it.meta ? { meta: Object.fromEntries(Object.entries(it.meta).map(([k, v]) => [k, rename(v)])) } : {}),
  };
}

/**
 * The planting function for one worlds file under one suite name, `perSeed` worlds a seed (worlds `seed * perSeed`
 * onward, wrapping): one for funnel and pi-ab, more for a `--days` user, who needs 12-20 requests a day.
 */
export function plantSynth(name: string, load: () => SynthWorld[], perSeed = 1) {
  let cache: SynthWorld[] | undefined;
  return (world: World, seed: number, variant: Variant): HiddenTask[] => {
    cache ??= load();
    const all = cache;
    if (!all.length) throw new Error(`synth: ${name} has no worlds`);
    const n = all.length;
    const ws = Array.from({ length: Math.min(perSeed, n) }, (_, j) => all[(((seed * perSeed + j) % n) + n) % n]!);
    const renames = ws.map((w) => renamer(w, world.user));
    // Background and neutral items take the place of base noise items, spread evenly over them.
    const noise = world.items.map((it, i) => (it.noise ? i : -1)).filter((i) => i >= 0);
    const extra = ws.flatMap((w, k) => {
      const planted = new Set(w.tasks.flatMap((t) => [t.fact, t.decoy]));
      return w.items.filter((i) => !planted.has(i.id)).map((it) => ({ it, rename: renames[k]! }));
    });
    if (extra.length > noise.length) throw new Error(`synth: ${name} has more items than the base world has noise`);
    const step = Math.max(1, Math.floor(noise.length / Math.max(1, extra.length)));
    extra.forEach(({ it, rename }, k) => {
      const at = noise[k * step]!;
      const ref = world.items[at]!.ref;
      world.items[at] = { ...toWorldItem(it, ref, world.now, rename), noise: true };
    });
    for (const w of ws) for (const [id, description] of Object.entries(w.sources)) world.sources[id] ??= description;
    const suite = variant === "hidden" ? name : `${name}-${variant}`;
    return ws.flatMap((w, k) => {
      const rename = renames[k]!;
      const items = new Map(w.items.map((i) => [i.id, i]));
      return w.tasks.map((t, ti) => {
        const english = t.requests.filter((r) => r.lang === "en" && r.style !== "follow-up");
        const req = english[(seed + ti) % english.length]!;
        if (variant !== "neutral") {
          const p = items.get(variant === "hidden" ? t.fact : t.decoy)!;
          world.items.push(toWorldItem(p, `${p.kind}-${world.items.length}`, world.now, rename));
        }
        return {
          id: `w${seed}:${suite}:${w.id}-${t.id}`,
          template: `${w.id}-${t.id}`,
          text: rename(req.text),
          detail: rename(t.detail),
        };
      });
    });
  };
}

/** The committed sample: a few validation-split worlds, enough for tests and a smoke run with no download. */
export const SAMPLE_PATH = new URL("../../../lab/synth/sample.jsonl", import.meta.url).pathname;

/** Where `synth-<split>` reads its worlds: `EDEN_SYNTH_DIR` or `.local/m2/synth/worlds` under the working directory. */
export const synthPath = (split: string) => `${process.env.EDEN_SYNTH_DIR ?? ".local/m2/synth/worlds"}/${split}.jsonl`;
