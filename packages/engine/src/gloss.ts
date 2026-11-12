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
 * `gloss.bin` (beside this file, gzip of JSON) holds, per language, its function words and its glossed words with up
 * to three English words each, written once by Haiku in the lab (`packages/sim/src/lab/gloss-make.ts`,
 * `gloss-pack.ts`). It is read once a process (`warmGlossary`, or the first glossed request), and a language's line
 * index is built the first time it is read. A file that cannot be read, or reads wrong, leaves every request as
 * written (fail open).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { isStopword } from "./text";

interface Lang {
  fn: Set<string>;
  /** `word\tgloss` lines sorted by word (code-unit order, as `gloss-pack.ts` writes them). */
  tsv: string;
  /** Where each line starts, made the first time the language is read: a binary search, not a Map (D998's lesson). */
  starts?: Uint32Array;
}
/** A loaded glossary: its languages, and every English word its glosses use (what reads as English in a request). */
export interface Glossary {
  langs: Map<string, Lang>;
  english: Set<string>;
}

/** Characters of a request read: the head says what it asks, and the gloss stays bounded. */
const GLOSS_CHARS = 400;
/**
 * English words a gloss gives at most. They are searched ahead of the request's own words (the cue keeps 16 terms),
 * and the request's names reach the search as entities whatever the gloss holds.
 */
export const MAX_GLOSS_WORDS = 12;
/** Words of one language a request must hold, past the English ones, to be read as that language. */
const MIN_HITS = 2;
/** Languages that write compounds as one word: an unknown word may be two known ones ("telefoon|rekening"). */
const COMPOUNDING = new Set(["de", "nl", "sv", "da", "no"]);
const LINKS = ["", "s", "e", "en", "n", "er"];

let loaded: Glossary | null | undefined;

/** The glossary in `file` (gzip of JSON, version 1), or null when it cannot be read or is not one. */
export function loadGlossary(file: string | URL): Glossary | null {
  try {
    const packed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as {
      v?: unknown;
      langs?: Record<string, { fn?: unknown; tsv?: unknown }>;
    };
    if (packed.v !== 1 || typeof packed.langs !== "object" || packed.langs === null) return null;
    const langs = new Map<string, Lang>();
    const english = new Set<string>();
    for (const [code, l] of Object.entries(packed.langs)) {
      if (!Array.isArray(l.fn) || typeof l.tsv !== "string") return null;
      langs.set(code, { fn: new Set(l.fn.filter((w): w is string => typeof w === "string")), tsv: l.tsv });
      for (const m of l.tsv.matchAll(/\t([^\n]*)/g)) for (const e of m[1]!.split(" ")) if (e) english.add(e);
    }
    return { langs, english };
  } catch {
    return null;
  }
}

/** Reads the shipped glossary now (once a process), so the first glossed request does not wait for it. */
export function warmGlossary(): Glossary | null {
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

const isCapital = (w: string) => w !== w.toLowerCase();

/**
 * The words that tell a request's language: lowercased, without the names. A capitalised word past the first, and a
 * word just before one ("van der Berg", "di Napoli", "la Gare"), is taken as part of a name: an English request about
 * Café du Monde or Pieter van den Heuvel is still English. German nouns are capitalised too; its other words decide.
 */
function telling(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i > 0 && isCapital(w)) continue;
    if (i > 0 && i + 1 < words.length && isCapital(words[i + 1]!)) continue;
    out.push(w.toLowerCase());
  }
  return out;
}

/**
 * The languages a request is written in: a language counts the request's telling words it knows (a function word or a
 * glossed word) that are not English, English counts those it knows that the language does not; the language wins
 * with at least `MIN_HITS` and more than English. The most first; ties all kept (Spanish and Portuguese share many).
 */
export function languagesOf(words: readonly string[], g: Glossary): string[] {
  const told = telling(words);
  let best = 0;
  let out: string[] = [];
  for (const [code, l] of g.langs) {
    // A language none of whose function words the request holds is not it: set lookups first, so an English
    // request never searches the lexicons.
    if (!told.some((w) => l.fn.has(w) && !isStopword(w))) continue;
    let mine = 0;
    let english = 0;
    for (const w of told) {
      const known = l.fn.has(w) || lookup(l, w) !== "";
      const en = isStopword(w) || g.english.has(w);
      if (known && !en) mine++;
      else if (en && !known) english++;
    }
    if (mine < MIN_HITS || mine <= english || mine < best) continue;
    if (mine > best) out = [];
    best = mine;
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
 * one-time load; no model, no call. Never throws: a glossary that reads wrong glosses nothing.
 */
export function glossOf(text: string, g: Glossary | null = warmGlossary()): string {
  if (!g || g.langs.size === 0) return "";
  try {
    const words =
      text
        .slice(0, GLOSS_CHARS)
        .normalize("NFC")
        .match(/\p{L}+/gu) ?? [];
    const codes = languagesOf(words, g);
    if (codes.length === 0) return "";
    const out: string[] = [];
    for (const raw of words) {
      const w = raw.toLowerCase();
      for (const code of codes) {
        const l = g.langs.get(code)!;
        if (l.fn.has(w)) continue;
        const e = lookup(l, w) || (COMPOUNDING.has(code) && w.length >= 7 ? compound(w, l) : "");
        for (const x of e.split(" ")) if (x && !out.includes(x)) out.push(x);
      }
      if (out.length >= MAX_GLOSS_WORDS) break;
    }
    return out.slice(0, MAX_GLOSS_WORDS).join(" ");
  } catch {
    return "";
  }
}
