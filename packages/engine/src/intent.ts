/**
 * The intent index (`intent`, off by default; docs/research/edge-intent.md): for each cached item, the requests it
 * would change, in a user's own words, indexed apart from the item's text, so a request can find an item it shares no
 * word with.
 *
 * Most of the decisive items the engine never reaches share no word with the request that runs into them ("approve the
 * laptop order" against "spend over £5,000 needs a second signature": docs/research/path-to-90.md). The fix moves the
 * vocabulary bridge to where a model may run: when an item is read for its implication card (`cards.ts`, in the
 * background, through a `Budget`), the same call writes up to `MAX_REQUESTS` requests the item would change (document
 * expansion, as docTTTTTquery does for passage retrieval). At request time no model runs: the request is scored
 * against those requests by BM25 here, and the partner fuses the result with its own lexical ranking.
 *
 * One index per user (`CardEnricher` holds it beside the user's cards), keyed by the item's content hash as cards
 * are: what the model wrote is held exactly as long as the card it came with (D8), dropped with the item, its source
 * or the user. The requests are model output: bounded, redacted (`sanitizeForStore`) and never shown to the agent;
 * they only say which cached items to consider, and an item found by them alone is a candidate, never a delivery.
 */
import { SparseIndex, Vocab } from "@eden/primitives";
import { sanitizeForStore } from "@eden/redact";
import type { EngineConfig } from "./config";
import { isStopword } from "./text";

/** The version of the requests' prompt (`cards.ts` `INTENT_INSTRUCTIONS`): a disk cache of requests is keyed by it. */
export const INTENT_VERSION = 2;
/** Requests kept per item, and characters per request: model output is bounded like any input. */
export const MAX_REQUESTS = 4;
export const MAX_REQUEST_CHARS = 120;
/** Terms of a query read at most: a request's head says what it asks (and keeps every search bounded). */
const MAX_QUERY_TERMS = 48;

/**
 * An item's requests as the model wrote them, validated: strings only, trimmed, clipped, redacted, duplicates and
 * empties out, at most `MAX_REQUESTS`. Anything else is no requests.
 */
export function cleanRequests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const t = sanitizeForStore(r.replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_CHARS));
    if (t.length > 0 && !out.includes(t)) out.push(t);
    if (out.length >= MAX_REQUESTS) break;
  }
  return out;
}

/**
 * A light suffix stemmer, so "approve", "approved" and "approving" meet, as "books", "booked" and "booking" do: a
 * model's paraphrase and the user's request rarely inflect alike. Plural and verb endings only; consistent rather
 * than linguistic (both sides go through it).
 */
export function stemWord(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(?:s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us")) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = undouble(s.slice(0, -3));
  else if (s.length > 4 && s.endsWith("ed")) s = undouble(s.slice(0, -2));
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}
const undouble = (s: string) => (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(?:ll|ss|zz)$/.test(s) ? s.slice(0, -1) : s);

/** A text's terms for the index: words of two characters or more, lowercased, stopwords out, stemmed. */
export function intentTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/'s$/, "").replace(/['-]+$/, "");
    if (w.length < 2 || isStopword(w)) continue;
    out.push(stemWord(w));
  }
  return out;
}

/**
 * Trial `intentPrune` (D480; docs/research/f2-quality.md): which of an item's requests are kept, judged against the
 * item with no model (Doc2Query--, arXiv 2301.03266, filters a model's expansions by their relevance to the passage
 * they were written for). The setting is a rule and its level, "" for none:
 * - `share:<x>`: a request is kept when at least `x` of its distinct terms (`intentTerms`) are terms of the item;
 * - `names`: a request is dropped when it names something (a capitalised word past its first, or a number) the item
 *   does not hold: a name the model brought from elsewhere;
 * - `top:<n>`: the `n` requests sharing most with the item are kept (ties: the model's order);
 * - `far:<n>`: the `n` sharing least are kept (the bridge the index exists for; ties: the model's order).
 * Pure and bounded: the item's first `PRUNE_READ` characters, at most `MAX_REQUESTS` requests.
 */
const PRUNE_READ = 4_000;
const NAME = /(?<=[\p{L}\p{N}\p{P}]\s+)\p{Lu}[\p{L}\p{N}'-]+|\p{N}[\p{L}\p{N}.,:/-]*/gu;

/** `intentPrune`'s rule, parsed; null when the setting is empty or not one of the rules (the checker refuses those). */
export function parsePrune(spec: string): { rule: "share" | "names" | "top" | "far"; level: number } | null {
  const m = /^(share|names|top|far)(?::(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) return null;
  const rule = m[1] as "share" | "names" | "top" | "far";
  if (rule === "names") return m[2] === undefined ? { rule, level: 0 } : null;
  return m[2] === undefined ? null : { rule, level: Number(m[2]) };
}

export function pruneRequests(requests: readonly string[], title: string, text: string, spec: string): string[] {
  const prune = parsePrune(spec);
  if (!prune || requests.length === 0) return [...requests];
  const body = `${title}\n${text.slice(0, PRUNE_READ)}`;
  if (prune.rule === "names") {
    const held = new Set(intentTerms(body));
    return requests.filter((r) => (r.match(NAME) ?? []).every((n) => intentTerms(n).every((t) => held.has(t))));
  }
  const held = new Set(intentTerms(body));
  const share = (r: string) => {
    const terms = new Set(intentTerms(r));
    let n = 0;
    for (const t of terms) if (held.has(t)) n++;
    return terms.size === 0 ? 0 : n / terms.size;
  };
  if (prune.rule === "share") return requests.filter((r) => share(r) >= prune.level);
  const by = requests.map((r, i) => ({ r, i, s: share(r) }));
  by.sort((a, b) => (prune.rule === "top" ? b.s - a.s : a.s - b.s) || a.i - b.i);
  const keep = new Set(by.slice(0, Math.max(0, Math.floor(prune.level))).map((x) => x.i));
  return requests.filter((_, i) => keep.has(i));
}

/** One item's place in a search (by content hash). */
export interface IntentHit {
  hash: string;
  /** BM25 over the item's requests. */
  score: number;
  /** Share of the query's known-term idf the requests hold, 0..1. */
  coverage: number;
  /** Distinct query terms the requests hold. */
  matched: number;
}

/** The vocabulary is rebuilt from the live docs past this many times its size after the last rebuild. */
const REBUILD_FACTOR = 4;
const MIN_REBUILD = 20_000;

/** One user's requests, indexed (BM25, one field). Never shared across users: each `UserCards` holds its own. */
export class IntentIndex {
  private vocab = new Vocab(256);
  private index = new SparseIndex();
  private readonly docOf = new Map<string, number>();
  private hashOf: (string | undefined)[] = [];
  /** Each doc's requests, kept to rebuild from (the vocabulary never forgets a term otherwise). */
  private readonly texts = new Map<string, string>();
  private baseline = 0;

  get size(): number {
    return this.docOf.size;
  }

  /** Sets (or replaces) a content hash's requests; none removes it. */
  set(hash: string, requests: readonly string[]): void {
    this.delete(hash);
    if (requests.length === 0) return;
    const text = requests.join("\n");
    this.texts.set(hash, text);
    this.add(hash, text);
    if (this.vocab.size > Math.max(MIN_REBUILD, this.baseline * REBUILD_FACTOR)) this.rebuild();
  }

  delete(hash: string): void {
    const doc = this.docOf.get(hash);
    if (doc === undefined) return;
    this.index.remove(doc);
    this.docOf.delete(hash);
    this.texts.delete(hash);
    if (this.hashOf[doc] === hash) this.hashOf[doc] = undefined;
  }

  /** The best `k` items for a request's text, best first. No term the index has never seen is interned. */
  search(text: string, k: number): IntentHit[] {
    if (this.docOf.size === 0 || k <= 0) return [];
    const ids: number[] = [];
    for (const t of intentTerms(text)) {
      const id = this.vocab.lookup(t);
      if (id >= 0 && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_QUERY_TERMS) break;
    }
    if (ids.length === 0) return [];
    const res = this.index.search(ids, ids.length, k);
    const out: IntentHit[] = [];
    for (let j = 0; j < res.count; j++) {
      const hash = this.hashOf[res.docs[j]!];
      if (hash === undefined) continue;
      out.push({ hash, score: res.scores[j]!, coverage: res.coverage[j]!, matched: res.matched[j]! });
    }
    return out;
  }

  private add(hash: string, text: string): void {
    const terms = intentTerms(text);
    const ids = new Uint32Array(terms.length);
    for (let i = 0; i < terms.length; i++) ids[i] = this.vocab.intern(terms[i]!);
    const doc = this.index.add(ids, ids.length);
    this.docOf.set(hash, doc);
    this.hashOf[doc] = hash;
  }

  /** A fresh vocabulary and index from the live docs: terms only removed docs held are forgotten. */
  private rebuild(): void {
    this.vocab = new Vocab(256);
    this.index = new SparseIndex();
    this.docOf.clear();
    this.hashOf = [];
    for (const [hash, text] of this.texts) this.add(hash, text);
    this.baseline = this.vocab.size;
  }
}

/** One raw hit as `CardEnricher.intentFinds` returns it: the cached items holding the requests, and the match. */
export interface IntentRow {
  ids: readonly string[];
  hit: { coverage: number; matched: number };
  /** The content holds a constraint card (any kind but `none`, made before the request). */
  carded?: boolean;
}

/** The thresholds and cut `keepIntents` applies (`EngineConfig`'s `intent*` keys). */
export interface IntentCut {
  /** Raw hits read, and ids kept, at most (`intentHits`). */
  hits: number;
  minCoverage: number;
  minMatched: number;
  /**
   * `intentByKind` (D200, on in the default): a constraint-carded hit counts from `cardCoverage` of the request's idf
   * rather than `minCoverage`, and up to `cardHits` such hits past the first `hits` raw hits (or past the `hits` ids)
   * are kept after the others. Null: one threshold for every hit, as before.
   */
  byKind: { cardCoverage: number; cardHits: number } | null;
}

/** An item kept from the intent hits: its place (0-based) and its match. */
export interface IntentKept {
  rank: number;
  coverage: number;
  matched: number;
}

/** The cut an engine configuration applies (`intentByKind` off: one threshold, as before D200). */
export function intentCut(
  c: Pick<
    EngineConfig,
    "intentHits" | "intentMinCoverage" | "intentMinMatched" | "intentByKind" | "intentCardCoverage" | "intentCardHits"
  >,
): IntentCut {
  return {
    hits: c.intentHits,
    minCoverage: c.intentMinCoverage,
    minMatched: c.intentMinMatched,
    byKind: c.intentByKind ? { cardCoverage: c.intentCardCoverage, cardHits: c.intentCardHits } : null,
  };
}

/**
 * With `intentByKind`, carded hits are looked for this many times `intentHits` deep: a carded item under the shared
 * threshold ranks low by BM25, behind uncarded hits that fill the first `intentHits`. On train, 1x `intentHits` raw
 * hits found 6 of the 9 hidden facts 3x found, at 2 decoys in pool more for 3x (fix-s3a-intent.md).
 */
const CARD_REACH = 3;

/**
 * How many raw hits the carded pass asks the store for under `cut` (0: no carded pass). The shared pass always reads
 * its own call of `hits`: the store skips hashes no longer cached or made too late before it cuts, so the first `hits`
 * rows of a deeper call are not the rows a call of `hits` returns, and reading them would widen the uncarded cut too.
 */
export function intentReach(cut: IntentCut): number {
  return cut.byKind && cut.byKind.cardHits > 0 ? cut.hits * CARD_REACH : 0;
}

/**
 * The raw hits (best first) that count as intent hits, item id → place. `rows` is the store's call of `hits`; `deep`,
 * with `byKind`, its call of `intentReach` (default `rows`). A hit counts with at least `minMatched` of the request's
 * terms and its threshold's share of their idf; its ids take the next places until `hits` ids are placed, over the
 * first `hits` of `rows` only. With `byKind`, a constraint-carded hit's threshold is `cardCoverage`, and carded hits
 * of `deep` left out by either cut take up to `cardHits` places after the others (an uncarded hit is read from `rows`
 * alone, as before D200): a stated constraint is what the reader is there to judge, and on train the carded misses
 * were mostly hidden facts, the uncarded mostly decoys (docs/research/fix-s3a-intent.md). Pure; no model, no call.
 */
export function keepIntents(
  rows: readonly IntentRow[],
  cut: IntentCut,
  deep: readonly IntentRow[] = rows,
): Map<string, IntentKept> {
  const out = new Map<string, IntentKept>();
  const by = cut.byKind;
  const passes = (r: IntentRow) =>
    r.hit.matched >= cut.minMatched && r.hit.coverage >= (by && r.carded ? by.cardCoverage : cut.minCoverage);
  const place = (r: IntentRow, until: number) => {
    for (const id of r.ids) {
      if (out.size >= until) return;
      if (!out.has(id)) out.set(id, { rank: out.size, coverage: r.hit.coverage, matched: r.hit.matched });
    }
  };
  for (const r of rows.slice(0, cut.hits)) {
    if (out.size >= cut.hits) break;
    if (passes(r)) place(r, cut.hits);
  }
  if (!by || by.cardHits <= 0) return out;
  const until = out.size + by.cardHits;
  for (const r of deep) {
    if (out.size >= until) break;
    if (r.carded && passes(r)) place(r, until);
  }
  return out;
}
