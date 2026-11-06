/**
 * `askExpand` (trial, D177): request-side query expansion for the ask's reader pool, with no model and no call.
 *
 * Some planted facts share no word with the request that they bear on ("contents insurance" against a welcome mail
 * for "home cover ... belongings"), so the ask's BM25F top 12 never holds them (audit 2026-11-06 F7, F10). This is
 * pseudo-relevance feedback over the user's own index: the request's best matches are read for the words they share
 * with one another but not with the request, and those words are searched once more. What that second search finds,
 * beyond what the ask already holds, may join the reader's pool after every candidate the ask found itself, so it
 * only fills seats the pool would leave empty; it is never a no-model delivery and never takes a seat from a
 * candidate. Everything reads the index's term sets and document counts: the items' text is never rescanned.
 */
import type { Scope } from "@eden/protocol";
import type { CacheHit, ItemCache } from "./cache";
import { isStopword } from "./text";

/** The request's best matches read for feedback. */
export const EXPAND_FEEDBACK = 5;
/** The most words added; each must be on at least `EXPAND_MIN_DOCS` of the feedback items. */
export const EXPAND_TERMS = 6;
export const EXPAND_MIN_DOCS = 2;
/** A word on more than this share of the user's items says nothing about a topic ("robin", "thanks"). */
export const EXPAND_MAX_SHARE = 0.05;
/** The fewest added words a found item must hold. */
export const EXPAND_MIN_MATCHED = 2;
/** The most items the expansion adds. */
export const EXPAND_HITS = 4;

const DIGIT = /\d/;

/**
 * Items the request's expansion reaches that are not in `held` (ids the ask already has), best first, at most
 * `EXPAND_HITS`. `query` is the request's term ids in the user's vocabulary, stopwords already left out (`rank`'s).
 */
export function expandAsk(
  cache: ItemCache,
  scope: Scope,
  query: readonly number[],
  held: ReadonlySet<string>,
  now: number,
): CacheHit[] {
  const vocab = cache.peekVocab(scope);
  if (!vocab || query.length === 0) return [];
  const feedback = cache.search(scope, query, query.length, EXPAND_FEEDBACK, now);
  if (feedback.length < EXPAND_MIN_DOCS) return [];
  const asked = new Set(query);
  const top = feedback[0]!.score;
  // Each word's weight: the feedback items holding it, each counted by its score against the best (relevance-model
  // style, with presence for frequency: the index keeps term sets), times its idf; and how many items hold it.
  const weight = new Map<number, number>();
  const docs = new Map<number, number>();
  for (const h of feedback) {
    const terms = cache.termsOf(scope, h.doc);
    const w = top > 0 ? h.score / top : 1;
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i]!;
      if (asked.has(t)) continue;
      weight.set(t, (weight.get(t) ?? 0) + w);
      docs.set(t, (docs.get(t) ?? 0) + 1);
    }
  }
  const scored: { t: number; s: number }[] = [];
  for (const [t, w] of weight) {
    const n = docs.get(t)!;
    if (n < EXPAND_MIN_DOCS) continue;
    const word = vocab.term(t);
    if (isStopword(word) || DIGIT.test(word) || word.length < 3) continue;
    const { df, live } = cache.docFreq(scope, t);
    // On no item beyond the feedback: it can reach nothing new. On too many: not a topic word.
    if (df <= n || df > Math.max(EXPAND_MIN_DOCS, live * EXPAND_MAX_SHARE)) continue;
    scored.push({ t, s: w * Math.log(1 + (live - df + 0.5) / (df + 0.5)) });
  }
  if (scored.length < EXPAND_MIN_MATCHED) return [];
  scored.sort((a, b) => b.s - a.s || a.t - b.t);
  const terms = scored.slice(0, EXPAND_TERMS).map((x) => x.t);
  const out: CacheHit[] = [];
  const seen = new Set(feedback.map((h) => h.item.id));
  for (const h of cache.search(scope, terms, terms.length, EXPAND_HITS * 4, now)) {
    if (out.length >= EXPAND_HITS) break;
    if (h.matched < EXPAND_MIN_MATCHED || held.has(h.item.id) || seen.has(h.item.id)) continue;
    out.push(h);
  }
  return out;
}
