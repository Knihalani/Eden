/**
 * Quality control for the synth factory (D882), LAB ONLY: near-duplicate detection (families against each other and
 * against the train suites, tasks against the train suites), clustering of families so a split never puts two
 * near-copies on opposite sides, and the request-leak check. Similarity is lexical (content-word sets and word
 * trigram shingles): cheap, deterministic, and what "a near copy" means for a template.
 */
import { createHash } from "node:crypto";
import { buildWorld } from "../../world";
import { plantTrain1 } from "../hidden-train1";
import { plantTrain2 } from "../hidden-train2";
import { plantTrain3 } from "../hidden-train3";
import { plantTrain4 } from "../hidden-train4";
import { plantTrain5 } from "../hidden-train5";
import { plantTrain6 } from "../hidden-train6";
import type { Family } from "./schema";

const STOP = new Set(
  (
    "a an the and or but if of to in on at for from by with about as is are was were be been being it its this that " +
    "these those i me my we our you your he she they them their his her him not no do does did can could should would " +
    "will shall may might must have has had so than then there here what when where which who whom why how all any " +
    "some more most other into over under up down out off again also just only very too each user users s t"
  ).split(" "),
);

/** Content words, lowercased, crudely stemmed (plural and -ing/-ed endings), stop words out. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9£$€]+/g) ?? [])
    .filter((w) => !STOP.has(w) && w.length > 1)
    .map((w) => w.replace(/(ing|ed|es|s)$/, "") || w);
}
export const wordSet = (text: string) => new Set(words(text));
export function shingles(text: string, n = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface TrainTemplate {
  suite: string;
  template: string;
  request: string;
  detail: string;
  fact: string;
  decoy: string;
}

/** Every train-suite template as text: request, detail, planted item and its control twin (seed 41's world). */
export function trainCorpus(seed = 41): TrainTemplate[] {
  const out: TrainTemplate[] = [];
  // The train planters are imported one by one, not through the suite registry: nothing here loads a held-out suite.
  const train = { plantTrain1, plantTrain2, plantTrain3, plantTrain4, plantTrain5, plantTrain6 };
  for (const [name, fn] of Object.entries(train)) {
    const suite = name.replace("plantT", "t");
    const plant = (variant: "hidden" | "control") => {
      const world = buildWorld({ seed: seed * 1_000 });
      const before = world.items.length;
      const tasks = fn(world, seed, variant);
      return { tasks, items: world.items.slice(before) };
    };
    const h = plant("hidden");
    const c = plant("control");
    h.tasks.forEach((t, i) =>
      out.push({
        suite,
        template: t.template,
        request: t.text,
        detail: t.detail,
        fact: `${h.items[i]!.title}\n${h.items[i]!.text}`,
        decoy: `${c.items[i]!.title}\n${c.items[i]!.text}`,
      }),
    );
  }
  return out;
}

/** A family's text for similarity: what makes it this scenario (not its area or archetype labels). */
export const familyText = (f: Pick<Family, "situation" | "request" | "fact" | "decoy">) =>
  `${f.situation} ${f.request} ${f.fact} ${f.decoy}`;
const trainText = (t: TrainTemplate) => `${t.request} ${t.detail}`;

export interface FamilyQc {
  /** Families kept, each with the id of its cluster (near neighbours share one). */
  kept: (Family & { cluster: string })[];
  /** Dropped as near copies of a train template, with the template. */
  nearTrain: { id: string; template: string; sim: number }[];
  /** Dropped as near copies of an earlier family. */
  nearFamily: { id: string; of: string; sim: number }[];
}

/**
 * Dedupes families: one whose request+fact is a near copy of a train template's request+detail (content-word Jaccard
 * at or above `trainMax`) is dropped; of two families at or above `dupMax` the later is dropped; families at or above
 * `clusterMin` are joined into one cluster (union-find), and the cluster, not the family, is what a split assigns.
 */
export function qcFamilies(
  families: Family[],
  train: TrainTemplate[],
  { trainMax = 0.2, dupMax = 0.33, clusterMin = 0.25 } = {},
): FamilyQc {
  const tr = train.map((t) => ({ t, s: wordSet(trainText(t)) }));
  const nearTrain: FamilyQc["nearTrain"] = [];
  const nearFamily: FamilyQc["nearFamily"] = [];
  const kept: { f: Family; s: Set<string> }[] = [];
  for (const f of families) {
    const core = wordSet(`${f.request} ${f.fact}`);
    let best = { sim: 0, template: "" };
    for (const { t, s } of tr) {
      const sim = jaccard(core, s);
      if (sim > best.sim) best = { sim, template: `${t.suite}/${t.template}` };
    }
    if (best.sim >= trainMax) {
      nearTrain.push({ id: f.id, ...best });
      continue;
    }
    const s = wordSet(familyText(f));
    const dup = kept.find((k) => jaccard(s, k.s) >= dupMax);
    if (dup) {
      nearFamily.push({ id: f.id, of: dup.f.id, sim: jaccard(s, dup.s) });
      continue;
    }
    kept.push({ f, s });
  }
  // Union-find over near neighbours: two families above `clusterMin` must land in the same split.
  const parent = kept.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < kept.length; i++)
    for (let j = i + 1; j < kept.length; j++)
      if (jaccard(kept[i]!.s, kept[j]!.s) >= clusterMin) parent[find(i)] = find(j);
  return {
    kept: kept.map((k, i) => ({ ...k.f, cluster: kept[find(i)]!.f.id })),
    nearTrain,
    nearFamily,
  };
}

/** A fixed hash of a cluster id to a split: 80% train, 10% val, 10% test, the same on every run. */
export function splitOfCluster(cluster: string): "train" | "val" | "test" {
  const x = parseInt(createHash("sha256").update(`m2-synth/${cluster}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
  return x < 0.8 ? "train" : x < 0.9 ? "val" : "test";
}

/** The highest trigram-shingle Jaccard of a text against the train templates' request, fact and decoy texts. */
export function nearestTrain(text: string, train: TrainTemplate[]): { sim: number; template: string } {
  const s = shingles(text);
  let best = { sim: 0, template: "" };
  for (const t of train)
    for (const x of [t.request, t.fact, t.decoy]) {
      const sim = jaccard(s, shingles(x));
      if (sim > best.sim) best = { sim, template: `${t.suite}/${t.template}` };
    }
  return best;
}

/**
 * A request leaks the fact when it states something only the fact states: a number, reference or capitalised word in
 * the fact that neither the decoy nor any neutral item carries. Names of the world's people (`known`) are not leaks:
 * a request may name who it is about. Returns the leaked tokens.
 */
export function leaks(request: string, fact: string, others: string[], known = new Set<string>()): string[] {
  const tok = (t: string) => new Set(t.match(/\b(?:[A-Z][a-zA-Z]{3,}|[A-Z0-9-]*\d[A-Z0-9-]*)\b/g) ?? []);
  const f = tok(fact);
  for (const o of others) for (const x of tok(o)) f.delete(x);
  // Calendar words and clock times are shared vocabulary, not the fact's own detail.
  const common =
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|June|July|August|September|October|November|December|Hi|Thanks|Dear|Best|Regards)$/;
  const r = tok(request);
  return [...f].filter((x) => r.has(x) && !known.has(x) && !common.test(x) && !/^\d{1,2}$/.test(x));
}
