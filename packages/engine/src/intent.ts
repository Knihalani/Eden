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
