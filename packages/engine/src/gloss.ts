/**
 * The request glossary (`requestGloss`, trial; F1, docs/research/f1-intent-bridge.md): a request written in another
 * language is given the English words its own words mean, with no model and no call, so the lexical search and the
 * intent index (whose requests the card model writes in English) can meet it.
 *
 * On heldout19 the non-English requests reached 0 of 16 planted facts in the funnel (h19-diagnosis.md): the card call
 * anticipated the right request ("move money out of the fixed saver") and the user wrote "spostare 5.000 sterline dai
 * risparmi". A word-for-word gloss ("move", "pound", "saving") is crude as translation and enough for retrieval, which
 * matches words, not sentences.
 *
 * `gloss.bin` (beside this file, gzip of JSON) holds, per language, its function words (the frequent words the gloss
 * left empty, used to tell the language) and its first 20,000 words by frequency with up to three English words
 * each, written once by Haiku in the lab (`packages/sim/src/lab/gloss-make.ts`, `gloss-pack.ts`). It is read the first
 * time a request is glossed, and a language's line index is built the first time a request is in that language. A file
 * that cannot be read leaves every request as written (fail open).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { isStopword } from "./text";

interface Packed {
  v: number;
  langs: Record<string, { fn: string[]; tsv: string }>;
}
interface Lang {
  fn: Set<string>;
  /** `word\tgloss` lines sorted by word (code-unit order, as `gloss-pack.ts` writes them). */
  tsv: string;
  /** Where each line starts, made the first time the language is read: a binary search, not a Map (D998's lesson). */
  starts?: Uint32Array;
}

/** Characters of a request read: the head says what it asks, and the gloss stays bounded. */
const GLOSS_CHARS = 400;
/** English words a gloss gives at most. */
export const MAX_GLOSS_WORDS = 24;
/** Function words of one language a request must hold, past English's, to be read as that language. */
const MIN_HITS = 2;
/** Languages that write compounds as one word: an unknown word may be two known ones ("telefoon|rekening"). */
const COMPOUNDING = new Set(["de", "nl", "sv", "da", "no"]);
const LINKS = ["", "s", "e", "en", "n", "er"];

let loaded: Map<string, Lang> | null | undefined;

/** The glossary in `file` (gzip of JSON), or null when it cannot be read. */
export function loadGlossary(file: string | URL): Map<string, Lang> | null {
  try {
    const packed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Packed;
    const out = new Map<string, Lang>();
    for (const [code, l] of Object.entries(packed.langs)) out.set(code, { fn: new Set(l.fn), tsv: l.tsv });
    return out;
  } catch {
    return null;
  }
}

function glossary(): Map<string, Lang> | null {
  if (loaded === undefined) loaded = loadGlossary(new URL("./gloss.bin", import.meta.url));
  return loaded;
}

/** A word's English in `l` ("" when it has none): a binary search over its sorted lines. */
function lookup(l: Lang, w: string): string {
  if (!l.starts) {
    const at = [0];
    for (let i = l.tsv.indexOf("\n"); i >= 0; i = l.tsv.indexOf("\n", i + 1)) at.push(i + 1);
    l.starts = Uint32Array.from(at);
  }
  const { tsv, starts } = l;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = starts[mid]!;
    const tab = tsv.indexOf("\t", start);
    const key = tsv.slice(start, tab);
    if (key === w) {
      const end = tsv.indexOf("\n", tab);
      return tsv.slice(tab + 1, end < 0 ? tsv.length : end);
    }
    if (key < w) lo = mid + 1;
    else hi = mid - 1;
  }
  return "";
}

/**
 * The languages a request is written in: those whose function words it holds at least `MIN_HITS` of (words English
 * also uses, such as "a" or "in", are not counted), the most first; ties all kept (Spanish and Portuguese share many).
 */
export function languagesOf(words: readonly string[], langs: ReadonlyMap<string, Lang>): string[] {
  let best = 0;
  let out: string[] = [];
  for (const [code, l] of langs) {
    let hits = 0;
    for (const w of words) if (l.fn.has(w) && !isStopword(w)) hits++;
    if (hits < MIN_HITS || hits < best) continue;
    if (hits > best) out = [];
    best = hits;
    out.push(code);
  }
  return out;
}

/** A compound's English: two known words, with a linking letter or two between them; "" when none splits it. */
function compound(w: string, l: Lang): string {
  for (let i = w.length - 3; i >= 3; i--) {
    const tail = lookup(l, w.slice(i));
    if (!tail) continue;
    for (const link of LINKS) {
      const head = w.slice(0, i);
      if (!head.endsWith(link) || head.length - link.length < 3) continue;
      const h = lookup(l, head.slice(0, head.length - link.length));
      if (h) return `${h} ${tail}`;
    }
  }
  return "";
}

/**
 * The English words a request's words mean when it is written in a language the glossary holds, space-separated,
 * at most `MAX_GLOSS_WORDS`; "" for an English request, an unknown language or no glossary. Pure apart from the
 * one-time load; no model, no call.
 */
export function glossOf(text: string, langs: ReadonlyMap<string, Lang> | null = glossary()): string {
  if (!langs || langs.size === 0) return "";
  const words =
    text
      .slice(0, GLOSS_CHARS)
      .toLowerCase()
      .match(/\p{L}+/gu) ?? [];
  const codes = languagesOf(words, langs);
  if (codes.length === 0) return "";
  const out: string[] = [];
  for (const w of words) {
    for (const code of codes) {
      const l = langs.get(code)!;
      if (l.fn.has(w)) continue;
      const g = lookup(l, w) || (COMPOUNDING.has(code) && w.length >= 7 ? compound(w, l) : "");
      for (const e of g.split(" ")) if (e && !out.includes(e)) out.push(e);
    }
    if (out.length >= MAX_GLOSS_WORDS) break;
  }
  return out.slice(0, MAX_GLOSS_WORDS).join(" ");
}
