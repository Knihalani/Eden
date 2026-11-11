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

/**
 * Hits read past the `k` asked for, so equal scores can be put in arrival order before the cut (D483): items that say
 * the same thing get the same requests and the same score, and which of them the index was given first is the order
 * the card model happened to read them in (`cardsOrder`), not a fact about the items.
 */
const TIE_SLACK = 16;

/** One user's requests, indexed (BM25, one field). Never shared across users: each `UserCards` holds its own. */
export class IntentIndex {
  private vocab = new Vocab(256);
  private index = new SparseIndex();
  /**
   * Per content hash: its doc, its requests (kept to rebuild from: the vocabulary never forgets a term otherwise) and
   * its place among equal scores (the order its content reached the user, `set`'s `seq`, lower first). One Map of
   * small records, not a Map a field (D998): an entry of a Map of thousands is 40-130 bytes in JSC, a record 48.
   */
  private readonly docs = new Map<string, { doc: number; text: string; seq: number }>();
  private hashOf: (string | undefined)[] = [];
  private nextSeq = 0;
  private baseline = 0;

  get size(): number {
    return this.docs.size;
  }

  /**
   * Sets (or replaces) a content hash's requests; none removes it. `seq`: its place among equal scores (lower
   * first); without one, the order of the calls.
   */
  set(hash: string, requests: readonly string[], seq?: number): void {
    this.delete(hash);
    if (requests.length === 0) return;
    const text = requests.join("\n");
    const at = seq ?? this.nextSeq;
    this.nextSeq = Math.max(this.nextSeq, seq ?? 0) + 1;
    this.add(hash, text, at);
    if (this.vocab.size > Math.max(MIN_REBUILD, this.baseline * REBUILD_FACTOR)) this.rebuild();
  }

  delete(hash: string): void {
    const d = this.docs.get(hash);
    if (d === undefined) return;
    this.index.remove(d.doc);
    this.docs.delete(hash);
    if (this.hashOf[d.doc] === hash) this.hashOf[d.doc] = undefined;
  }

  /** The best `k` items for a request's text, best first. No term the index has never seen is interned. */
  search(text: string, k: number): IntentHit[] {
    if (this.docs.size === 0 || k <= 0) return [];
    const ids: number[] = [];
    for (const t of intentTerms(text)) {
      const id = this.vocab.lookup(t);
      if (id >= 0 && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_QUERY_TERMS) break;
    }
    if (ids.length === 0) return [];
    const res = this.index.search(ids, ids.length, k + TIE_SLACK);
    const out: IntentHit[] = [];
    for (let j = 0; j < res.count; j++) {
      const hash = this.hashOf[res.docs[j]!];
      if (hash === undefined) continue;
      out.push({ hash, score: res.scores[j]!, coverage: res.coverage[j]!, matched: res.matched[j]! });
    }
    out.sort((a, b) => b.score - a.score || this.docs.get(a.hash)!.seq - this.docs.get(b.hash)!.seq);
    return out.slice(0, k);
  }

  private add(hash: string, text: string, seq: number): void {
    const terms = intentTerms(text);
    const ids = new Uint32Array(terms.length);
    for (let i = 0; i < terms.length; i++) ids[i] = this.vocab.intern(terms[i]!);
    const doc = this.index.add(ids, ids.length);
    this.docs.set(hash, { doc, text, seq });
    this.hashOf[doc] = hash;
  }

  /**
   * The index as data (D998: a user's card state frozen with them): each doc's hash, requests and place among equal
   * scores, in the order `rebuild` adds them, and the next place. `IntentIndex.from` makes the same index again.
   */
  export(): { docs: [string, string, number][]; nextSeq: number } {
    return { docs: [...this.docs].map(([hash, d]) => [hash, d.text, d.seq]), nextSeq: this.nextSeq };
  }

  /** The index `export` saved, built as `rebuild` builds one: the same docs in the same order, so the same finds. */
  static from(saved: { docs: [string, string, number][]; nextSeq: number }): IntentIndex {
    const x = new IntentIndex();
    for (const [hash, text, seq] of saved.docs) x.add(hash, text, seq);
    x.nextSeq = saved.nextSeq;
    x.baseline = x.vocab.size;
    return x;
  }

  /** A fresh vocabulary and index from the live docs: terms only removed docs held are forgotten. */
  private rebuild(): void {
    this.vocab = new Vocab(256);
    this.index = new SparseIndex();
    const live = [...this.docs];
    this.docs.clear();
    this.hashOf = [];
    for (const [hash, d] of live) this.add(hash, d.text, d.seq);
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
