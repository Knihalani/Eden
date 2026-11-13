/**
 * F1: packs `gloss-make.ts`'s output into the engine's `gloss.bin` (the packed layout, version 2, D1710:
 * `packGlossary`, which gloss.ts reads; version 1 was gzip of JSON). Per
 * language: its function words (`fn` lines, less any an English request also uses: an English stopword or a word the
 * glosses use, so "die" or "has" never tells German or Dutch from English) and its glossed words (one word each, NFC,
 * its glosses from every topic merged, at most three English words; a word whose gloss is itself is left out:
 * searching it again adds nothing).
 *
 *   bun packages/sim/src/lab/gloss-pack.ts --gloss DIR --out packages/engine/src/gloss.bin
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GlossLang, isStopword, packGlossary } from "@eden/engine";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) throw new Error(`--${k} is required`);
  return argv[i + 1]!;
};
const GLOSS = opt("gloss");
const WORD = /^\p{L}+$/u;
const MAX_ENGLISH = 3;

const read = (f: string) =>
  readFileSync(join(GLOSS, f), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      // A writer's malformed line is skipped, not fatal: the vocabulary is written by models (subagents or the API).
      try {
        const v = JSON.parse(l) as { w?: unknown; g?: unknown; fn?: unknown };
        return typeof v.w === "string" ? [{ w: v.w, g: typeof v.g === "string" ? v.g : "", fn: v.fn === true }] : [];
      } catch {
        return [];
      }
    });
const files = readdirSync(GLOSS)
  .filter((f) => f.endsWith(".jsonl"))
  .sort();
const tables = new Map<string, { fn: Set<string>; g: Map<string, string[]> }>();
const english = new Set<string>();
for (const f of files) {
  const fn = new Set<string>();
  const g = new Map<string, string[]>();
  for (const { w: raw, g: e, fn: isFn } of read(f)) {
    const w = raw.normalize("NFC").toLowerCase();
    if (!WORD.test(w)) continue;
    if (isFn) {
      fn.add(w);
      continue;
    }
    // English letters only: the gloss is searched as English words.
    const words = e
      .replace(/[^a-z ]/g, " ")
      .split(" ")
      .filter((x) => x.length > 1);
    const have = g.get(w) ?? [];
    for (const x of words) if (have.length < MAX_ENGLISH && !have.includes(x)) have.push(x);
    g.set(w, have);
    for (const x of words) english.add(x);
  }
  tables.set(f.slice(0, -6), { fn, g });
}
const langs: GlossLang[] = [];
let words = 0;
for (const [lang, { fn, g }] of tables) {
  const fns = [...fn].filter((w) => !isStopword(w) && !english.has(w)).sort();
  const glosses = [...g]
    .filter(([w, e]) => e.length > 0 && !(e.length === 1 && e[0] === w) && !fn.has(w))
    .map(([w, e]): [string, string] => [w, e.join(" ")]);
  words += glosses.length;
  langs.push({ code: lang, fn: fns, glosses });
  console.log(`${lang}: ${fns.length} function words, ${glosses.length} glossed`);
}
const bin = packGlossary(langs);
writeFileSync(opt("out"), bin);
console.log(`${langs.length} languages, ${words} words, ${bin.length} bytes -> ${opt("out")}`);
