/**
 * F1: packs `gloss-make.ts`'s output into the engine's `gloss.bin` (gzip of JSON; gloss.ts reads it). Per language:
 * its function words (the first `--fn` words of its frequency list whose gloss is empty or English stopwords only,
 * less any of the first `--en` English words, so "die" or "has" never tells German or Dutch from English) and its
 * glossed words (a word whose gloss is itself is left out: searching it again adds nothing).
 *
 *   bun packages/sim/src/lab/gloss-pack.ts --freq DIR --gloss DIR --out packages/engine/src/gloss.bin [--fn 300]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { isStopword } from "@eden/engine";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  if (i >= 0) return argv[i + 1]!;
  if (d === undefined) throw new Error(`--${k} is required`);
  return d;
};
const FREQ = opt("freq");
const GLOSS = opt("gloss");
const FN = Number(opt("fn", "300"));
const EN = Number(opt("en", "2000"));

const ranked = (lang: string) =>
  readFileSync(join(FREQ, `${lang}.txt`), "utf8")
    .split("\n")
    .map((l) => l.split(" ")[0]?.toLowerCase() ?? "")
    .filter((w) => /^\p{L}{2,}$/u.test(w));
const english = new Set(ranked("en").slice(0, EN));
const langs: Record<string, { fn: string[]; tsv: string }> = {};
let words = 0;
for (const f of readdirSync(GLOSS)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()) {
  const lang = f.slice(0, -6);
  const g = new Map<string, string>();
  for (const l of readFileSync(join(GLOSS, f), "utf8").split("\n")) {
    if (!l) continue;
    const { w, g: e } = JSON.parse(l) as { w: string; g: string };
    // English letters and spaces only: the gloss is searched as English words.
    g.set(
      w,
      e
        .replace(/[^a-z ]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  const fn = ranked(lang)
    .slice(0, FN)
    .filter(
      (w) =>
        g.has(w) &&
        !english.has(w) &&
        g
          .get(w)!
          .split(" ")
          .every((e) => e === "" || isStopword(e)),
    );
  const lines = [...g]
    .filter(([w, e]) => e !== "" && e !== w)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([w, e]) => `${w}\t${e}`);
  words += lines.length;
  langs[lang] = { fn, tsv: lines.join("\n") };
  console.log(`${lang}: ${fn.length} function words, ${lines.length} glossed`);
}
const bin = gzipSync(JSON.stringify({ v: 1, langs }), { level: 9 });
writeFileSync(opt("out"), bin);
console.log(`${Object.keys(langs).length} languages, ${words} words, ${bin.length} bytes -> ${opt("out")}`);
