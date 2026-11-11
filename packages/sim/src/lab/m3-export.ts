/**
 * `m3-export.ts` (M3, D900): training and screening data for a retriever trained on Eden's own question, "which held
 * item bears on this request?". For each seed, one world holding every template of the named suites at once, its
 * planted fact (hidden) and its near-miss decoy (control) both: the base world as `userWorldOf` builds it, every
 * item as its source lists it and the cache holds it (redacted). One line a seed:
 *
 *   {seed, items: [{id, title, text}], tasks: [{suite, template, request, pos, decoy}]}
 *
 * `pos` is the planted item's id, `decoy` the control variant's item (a hard negative for the same request). Every
 * other template's fact and decoy is in the same world, as over a user's days (D712). Simulated data only.
 *
 *   bun packages/sim/src/lab/m3-export.ts --seeds 100-163 --suites train1,train2,train3,train4 --out FILE
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { sanitizeItem } from "@eden/engine";
import { REALISTIC, simSources } from "../sources";
import { suiteTemplates, userWorldOf, type UserPlanEntry } from "./pi-user";
import { parseSuites } from "./suites";

export interface ExportTask {
  suite: string;
  template: string;
  request: string;
  pos: string;
  decoy: string;
}

/** Seeds from "a-b" or "a,b,c". */
export function parseSeeds(spec: string): number[] {
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  return spec.split(",").map(Number);
}

/** One seed's world with every template's fact and decoy, and the tasks that join them. */
export function exportSeed(seed: number, suites: readonly string[]) {
  const templates = suiteTemplates(seed, suites);
  const entries = (variant: UserPlanEntry["variant"]): UserPlanEntry[][] => [
    Object.entries(templates).flatMap(([suite, names]) => names.map((template) => ({ suite, template, variant }))),
  ];
  const hidden = userWorldOf(seed, entries("hidden"));
  const control = userWorldOf(seed, entries("control"));
  // The two worlds share the base world; the control world's decoys get ids of their own beside the hidden world's.
  const decoyId = new Map<string, string>();
  const items = [...hidden.world.items];
  for (const t of control.tasks) {
    const it = control.world.items.find((i) => i.id === t.planted);
    if (!it) continue;
    const id = `${it.id}~decoy`;
    decoyId.set(`${t.suite}|${t.type}`, id);
    items.push({ ...it, id, ref: `${it.ref}~decoy` });
  }
  const world = { ...hidden.world, items };
  const listed = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
  const out = listed.map((raw) => {
    const it = sanitizeItem(raw);
    return { id: raw.id, title: it.title, text: it.text.slice(0, 1_200) };
  });
  const tasks: ExportTask[] = hidden.tasks
    .filter((t) => t.planted)
    .map((t) => ({
      suite: t.suite!,
      template: t.type,
      request: t.text,
      pos: t.planted!,
      decoy: decoyId.get(`${t.suite}|${t.type}`) ?? "",
    }));
  return { seed, items: out, tasks };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  const seeds = parseSeeds(opt("seeds", "100-101"));
  const suites = parseSuites(opt("suites", "train"));
  if (suites.some((s) => !s.startsWith("train"))) throw new Error("m3-export: train suites only");
  const out = opt("out", "");
  if (!out) throw new Error("--out FILE");
  writeFileSync(out, "");
  for (const seed of seeds) {
    const row = exportSeed(seed, suites);
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(`seed ${seed}: ${row.items.length} items, ${row.tasks.length} tasks`);
  }
}
