/**
 * F13: the CPU match of each task's request against its world's anticipations ($0; LAB ONLY, sim data).
 *
 *   bun packages/sim/lab/f13/match.ts SHEETS.jsonl ANTS.jsonl MODEL_DIR OUT.jsonl [--arm pass|cards]
 *
 * `pass`: the anticipation pass's acts, days and names (`pass.ts read`). `cards`: the free baseline, each sheet
 * card's own anticipated requests (the intent index's) with the card's span and entities. For every task, the five
 * rules whose acts score highest against the request (multilingual-e5-small int8 on CPU, cosine of "query: " vectors,
 * the best act a rule), each with its grounds: `day` (the request names days and the rule's span holds none of them:
 * false; else true) and `who` (the rule names people or references and the request mentions none of them: false).
 * `score.py` reads the rows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { timeWindow } from "../../../engine/src/grounding";
import { Encoder } from "../../../encoder/src/index";

const NOW = Date.UTC(2026, 9, 27, 9);
const [sheetsPath, antsPath, modelDir, outPath] = process.argv.slice(2);
const arm = process.argv.includes("--arm") ? process.argv[process.argv.indexOf("--arm") + 1]! : "pass";

type Ant = { id: string; acts: string[]; on?: [string, string]; who: string[]; warn: string };
const sheets = readFileSync(sheetsPath!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ants = new Map<string, Ant[]>();
if (arm === "pass" || arm === "union") {
  for (const l of readFileSync(antsPath!, "utf8").split("\n").filter(Boolean)) {
    const d = JSON.parse(l);
    if (!d.complete) continue;
    ants.set(`${d.suite}|${d.seed}|${d.variant}`, d.ants);
  }
}
if (arm === "cards" || arm === "union") {
  for (const w of sheets) {
    const key = `${w.suite}|${w.seed}|${w.variant}`;
    if (arm === "union" && !ants.has(key)) continue;
    const had = new Map((ants.get(key) ?? []).map((a) => [a.id, a]));
    if (arm === "union" && !had.size) continue;
    const fromCards: Ant[] = w.sheet
      .filter((s: { r: string[] }) => s.r?.length)
      .map((s: { id: string; r: string[]; c: { start?: string; end?: string; entities?: string[] } }) => ({
        id: s.id,
        acts: s.r.slice(0, 4),
        ...(s.c.start || s.c.end ? { on: [s.c.start ?? "0000-01-01", s.c.end ?? "9999-12-31"] } : {}),
        who: s.c.entities ?? [],
        warn: "",
      }));
    if (arm === "cards") {
      ants.set(key, fromCards);
      continue;
    }
    // `union`: a rule the pass kept gets the card's requests beside its own acts, with the pass's days and names; a
    // rule the pass left out stays out (the pass judged it changes no action).
    ants.set(
      key,
      [...had.values()].map((a) => ({ ...a, acts: [...a.acts, ...(fromCards.find((c) => c.id === a.id)?.acts ?? [])] })),
    );
  }
}

const enc = await Encoder.load(modelDir!);
const memo = new Map<string, Float32Array>();
async function vecs(texts: string[]): Promise<Float32Array[]> {
  const need = [...new Set(texts.filter((t) => !memo.has(t)))];
  for (let i = 0; i < need.length; i += 16) {
    const got = await enc.embed(need.slice(i, i + 16).map((t) => `query: ${t}`));
    got.forEach((v, j) => memo.set(need[i + j]!, v));
  }
  return texts.map((t) => memo.get(t)!);
}
const dot = (a: Float32Array, b: Float32Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i]! * b[i]!;
  return n;
};

/** A name or reference "mentioned": any of its words of 3+ letters (or any id) on a word boundary of the request. */
function mentions(request: string, who: string): boolean {
  const r = request.toLowerCase();
  const words = who.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return words.some((w) => (w.length >= 3 || /\d/.test(w)) && new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(r));
}

const out: string[] = [];
let t0 = performance.now();
let reqMs = 0;
let reqs = 0;
for (const w of sheets) {
  const got = ants.get(`${w.suite}|${w.seed}|${w.variant}`);
  if (!got) continue;
  const list = got;
  const actVecs = await vecs(list.flatMap((a) => a.acts));
  for (const t of w.tasks) {
    const r0 = performance.now();
    const [q] = await vecs([t.request]);
    let k = 0;
    const scored = list.map((a) => {
      let best = -1;
      for (let i = 0; i < a.acts.length; i++) best = Math.max(best, dot(q!, actVecs[k + i]!));
      k += a.acts.length;
      return { a, best };
    });
    scored.sort((x, y) => y.best - x.best);
    // The request's typical score over the user's rules: a request near every rule (a topic the sheet is full of)
    // reads high everywhere, so the margin over this is the `margin` arm's score (score.py).
    const med = scored.length ? scored[Math.floor(scored.length / 2)]!.best : 0;
    const days = timeWindow(t.request, NOW)?.days;
    const top = scored.slice(0, 5).map(({ a, best }) => ({
      id: a.id,
      s: Number(best.toFixed(4)),
      day: !(days && days.size && a.on && ![...days].some((d) => d >= a.on![0] && d <= a.on![1])),
      who: a.who.length === 0 || a.who.some((x) => mentions(t.request, x)),
    }));
    reqMs += performance.now() - r0;
    reqs++;
    out.push(
      JSON.stringify({
        suite: w.suite,
        seed: w.seed,
        variant: w.variant,
        template: t.template,
        planted: t.planted,
        rules: list.length,
        med: Number(med.toFixed(4)),
        top,
      }),
    );
  }
}
writeFileSync(outPath!, `${out.join("\n")}\n`);
console.log(
  JSON.stringify({
    arm,
    tasks: reqs,
    msPerRequestMatch: Number((reqMs / reqs).toFixed(2)),
    totalS: Number(((performance.now() - t0) / 1000).toFixed(1)),
  }),
);
