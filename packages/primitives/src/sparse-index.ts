/**
 * An in-memory inverted index with BM25 scoring over term ids (from `Vocab`/`tokenizeInto`), for one user's cache.
 *
 * Two tiers, packed (2026-11-03; `sparse-index.reference.ts` is the layout before, kept as the oracle):
 *
 * - **Frozen.** Postings in compressed sparse rows: one offset per (term, field) key into one doc array (Uint16 while
 *   doc numbers fit, else Uint32) and one term-frequency byte array (255 means "look it up in `bigTf`"). Each doc's
 *   sorted unique term ids sit in one forward arena (Uint16 while term ids fit). No array per key or per doc: the
 *   reference spent 74 bytes of header on each of its two arrays per key, and 72% of keys hold one posting.
 * - **Delta.** Docs added since the last freeze, in an append-only forward arena of sorted unique term ids with their
 *   per-field term frequencies (bytes, same escape), and no postings. A query scans the delta, binary-searching each
 *   doc's terms, while it holds at most `DELTA_DOCS` docs: a user with fewer docs never freezes and pays for no
 *   postings, no per-key offsets and no per-term arrays beyond df (the light-user path). A heavy index's larger delta
 *   is also chained per term (a head per term id; a next and a doc per arena slot), so a query reads only the delta
 *   docs that hold its terms.
 *
 * Freezing merges the delta into new frozen arrays in one linear pass over the postings, keeping each key's postings
 * in insertion order (a doc number is reused only after its postings are purged, so frozen postings are older than
 * delta docs). It runs when the delta is full (`DELTA_DOCS`, then an eighth of the index up to `MAX_DELTA_DOCS`),
 * and, purging the removed docs' postings, at exactly the reference's compaction points: removal marks a doc dead
 * (skipped when scoring) and updates df and lengths at once; when dead postings reach ~10% of all postings (or on
 * `flush`) they are purged, the dead docs' numbers are freed for reuse and each term no live doc holds any more is
 * reported (`onTermFreed`): from then on nothing in the index refers to that term id, so its owner may release it
 * (`Vocab.release`) and the id may come back as another term.
 *
 * Scores, ranking, coverage and doc numbers are identical to the reference: each doc's contributions are summed in the
 * same order into the same Float32 accumulator, and candidates reach top-k in the same order (each key's postings in
 * insertion order, frozen before delta).
 *
 * Fields. A doc may have several fields (title, body): each field has its own postings, length normalization (`b`)
 * and weight, and a doc's score is the weighted sum of per-field BM25 (the multi-field model Lucene and Orama use).
 * idf is per term over docs (any field). With one field this is plain BM25. `delta` > 0 gives BM25+ (a floor per
 * matched term and field).
 *
 * Each result carries what the engine's confidence needs besides the score: idf-weighted query coverage (share of
 * the query's known-term idf the doc holds, 0..1, comparable across queries) and the number of distinct query terms
 * matched (each counted once per doc, whatever the fields).
 *
 * Limits: under 2^22 doc numbers and 2^31 (term, field) keys per index (the `bigTf` key packs both into a double).
 */
import { TopK } from "./topk";

export interface SparseIndexOptions {
  k1?: number;
  /** Fields per doc (default 1). */
  fields?: number;
  /** Per field: length normalization, default 0.75. */
  b?: number[];
  /** Per field: weight, default 1. */
  weights?: number[];
  /** BM25+ lower bound per matched term and field, default 0 (plain BM25). */
  delta?: number;
  /**
   * Called during compaction for each term id that no doc, live or dead, refers to any more (its last holder was
   * removed and its postings purged). Not called for a term that was never added.
   */
  onTermFreed?: (term: number) => void;
}

export interface SearchResults {
  count: number;
  docs: Int32Array;
  scores: Float64Array;
  coverage: Float32Array;
  matched: Uint8Array;
}

/**
 * Docs the delta holds (live or removed) before it is frozen. Up to `DELTA_DOCS` a query scans the delta (about one
 * binary search per delta doc and query term); past it (an index of over 1,024 live docs) the delta is chained per
 * term and grows with the index (an eighth of its live docs, up to `MAX_DELTA_DOCS`), since a freeze costs one pass
 * over every posting (bench/index-memory.bench.ts measured both).
 */
const DELTA_DOCS = 128;
const MAX_DELTA_DOCS = 512;

/** A term frequency byte of 255 means the frequency is 255 or more and is held in `bigTf`. */
const TF_ESCAPE = 255;
/** `bigTf` key: key × 2^22 + doc, exact in a double while key < 2^31. */
const DOC_SPAN = 4_194_304;

// Where a doc number stands.
const FREE = 0;
const FROZEN = 1;
const DELTA = 2;
const FROZEN_DEAD = 3;
const DELTA_DEAD = 4;

const EMPTY = new Uint32Array(0);

type Docs = Uint16Array | Uint32Array;
type Terms = Uint16Array | Uint32Array;

// Insert and query scratch, shared by every index: JavaScript runs one `addFields` or `search` at a time and neither
// yields, so one copy serves all. Per term id: per-field counts tagged with a stamp (no clearing, no hashing), the
// doc-level seen stamp, the touched-term lists and the query that last held each term (a repeated query term is
// skipped in O(1)). Per doc number: the score, coverage and match accumulators, the term that last counted, the
// touched list and a delta doc's position of the current query term. Stamps only grow and are shared, so a stamp left
// by one index never equals a later one of another.
let tfCount: Uint32Array = new Uint32Array(1_024);
let tfStamp: Uint32Array = new Uint32Array(1_024);
let docStamp: Uint32Array = new Uint32Array(1_024);
let stampNo = 0;
let fieldTouched: Uint32Array = new Uint32Array(1_024);
let docTouched: Uint32Array = new Uint32Array(1_024);
let queryTermStamp: Uint32Array = new Uint32Array(1_024);
let termQueryNo = 0;
// A field's (term, count) pairs, kept until the doc's sorted term list gives each its slot.
let pairTerm: Uint32Array = new Uint32Array(1_024);
let pairCount: Uint32Array = new Uint32Array(1_024);
let acc: Float32Array = new Float32Array(1_024);
let cov: Float32Array = new Float32Array(1_024);
let hit: Uint32Array = new Uint32Array(1_024);
let stamp: Uint32Array = new Uint32Array(1_024);
let touched: Int32Array = new Int32Array(1_024);
let queryNo = 0;
// A query term's places in the delta (arena position and doc), in insertion order: a term is once per doc at most.
const hitPos = new Int32Array(MAX_DELTA_DOCS);
const hitDoc = new Int32Array(MAX_DELTA_DOCS);

/** Grows the insert scratch so term id `t` fits; lists are sized like the arrays (a field has ≤ that many terms). */
function growScratch(t: number): void {
  let size = tfCount.length;
  while (size <= t) size *= 2;
  tfCount = growU32(tfCount, size);
  tfStamp = growU32(tfStamp, size);
  docStamp = growU32(docStamp, size);
  fieldTouched = growU32(fieldTouched, size); // may grow mid-field: keep what this field touched so far
  docTouched = growU32(docTouched, size);
}

/** Grows the per-doc query scratch so doc numbers below `docs` fit (it holds zeros between searches). */
function growDocScratch(docs: number): void {
  let size = acc.length;
  while (size < docs) size *= 2;
  acc = new Float32Array(size);
  cov = new Float32Array(size);
  hit = new Uint32Array(size);
  stamp = new Uint32Array(size);
  touched = new Int32Array(size);
}

export class SparseIndex {
  private readonly k1: number;
  private readonly fields: number;
  private readonly b: Float64Array;
  private readonly weights: Float64Array;
  private readonly delta: number;
  private readonly onTermFreed: ((term: number) => void) | undefined;
  // Per term id: docs (any field) that hold it.
  private df: Uint32Array = new Uint32Array(16);
  // Per doc (× fields for lengths): where it stands, and its slice of its tier's forward arena.
  private lens: Float32Array;
  private where: Uint8Array = new Uint8Array(16);
  private fwdStart: Uint32Array = new Uint32Array(16);
  private fwdLen: Uint32Array = new Uint32Array(16);
  // Frozen tier: postings of key k in [keyStart[k], keyStart[k + 1]) of fDocs/fTfs, for k < fKeys.
  private fKeys = 0;
  private keyStart: Uint32Array = EMPTY;
  private fDocs: Docs = new Uint16Array(0);
  private fTfs: Uint8Array = new Uint8Array(0);
  private fFwd: Terms = new Uint16Array(0);
  // Delta tier: its docs in insertion order; their sorted unique terms (dFwd) and per-field frequencies (dTf, × F).
  private deltaDocs: Int32Array = new Int32Array(16);
  private deltaCap = DELTA_DOCS;
  private deltaN = 0;
  private dFwd: Uint32Array = new Uint32Array(0);
  private dTf: Uint8Array = new Uint8Array(0);
  private dUsed = 0;
  /**
   * While the delta may hold more than `DELTA_DOCS` docs (a heavy index), it is also chained per term so a query does
   * not scan it: per term id, the arena position of its newest delta occurrence (-1: none); per position, the next
   * older one and its doc. Null while a scan is short enough: a light or medium index pays no per-term memory for it.
   */
  private dHead: Int32Array | null = null;
  private dNext: Int32Array = new Int32Array(0);
  private dDoc: Int32Array = new Int32Array(0);
  /** Term frequencies of 255 or more, by (key, doc). Almost always empty. */
  private bigTf = new Map<number, number>();
  private readonly totalLens: Float64Array;
  private docs = 0;
  private live = 0;
  // The reference's posting counters, kept exactly so compaction (and so `onTermFreed`) runs when its did.
  private deadPostings = 0;
  private totalPostings = 0;
  // Postings of removed delta docs a freeze left out of the frozen tier, still counted in `totalPostings`.
  private droppedDead = 0;
  // Term ids some live doc holds (df > 0).
  private liveTerms = 0;
  private freeDocs: number[] = [];
  private pendingFree: number[] = [];

  constructor(options: SparseIndexOptions = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.fields = Math.max(1, options.fields ?? 1);
    this.b = Float64Array.from({ length: this.fields }, (_, f) => options.b?.[f] ?? 0.75);
    this.weights = Float64Array.from({ length: this.fields }, (_, f) => options.weights?.[f] ?? 1);
    this.delta = options.delta ?? 0;
    this.onTermFreed = options.onTermFreed;
    this.totalLens = new Float64Array(this.fields);
    this.lens = new Float32Array(16 * this.fields);
  }

  /** Live documents. */
  get size(): number {
    return this.live;
  }

  /** Distinct term ids that some live doc holds. */
  get termCount(): number {
    return this.liveTerms;
  }

  /** Adds a one-field doc from its term ids in order (repeats are its term frequencies). Returns its doc number. */
  add(terms: Uint32Array, n: number): number {
    return this.addFields([terms], [n]);
  }

  /** Adds a doc with one term-id array per field (`fieldTerms[f][0..counts[f])`). Returns its doc number. */
  addFields(fieldTerms: Uint32Array[], counts: number[]): number {
    const F = this.fields;
    const doc = this.allocateDoc();
    if (stampNo > 0xffff_fff0 - F) {
      // Stamps are Uint32: before the counter wraps, clear them so an old stamp can never equal a new one.
      tfStamp.fill(0);
      docStamp.fill(0);
      stampNo = 0;
    }
    const docMark = ++stampNo;
    let docUnique = 0;
    let pairs = 0;
    // The scratch in locals (module bindings read slower in a hot loop); reloaded when `growScratch` replaces it.
    let count = tfCount;
    let fieldStamp = tfStamp;
    let seen = docStamp;
    let fieldList = fieldTouched;
    let docList = docTouched;
    const fieldEnd = new Uint32Array(F);
    for (let f = 0; f < F; f++) {
      const terms = fieldTerms[f];
      const n = terms === undefined ? 0 : (counts[f] ?? 0);
      const fieldMark = ++stampNo;
      let fieldUnique = 0;
      for (let i = 0; i < n; i++) {
        const t = terms![i]!;
        if (t >= count.length) {
          growScratch(t);
          [count, fieldStamp, seen, fieldList, docList] = [tfCount, tfStamp, docStamp, fieldTouched, docTouched];
        }
        if (fieldStamp[t] !== fieldMark) {
          fieldStamp[t] = fieldMark;
          count[t] = 0;
          fieldList[fieldUnique++] = t;
        }
        count[t]!++;
        if (seen[t] !== docMark) {
          seen[t] = docMark;
          docList[docUnique++] = t;
        }
      }
      if (pairs + fieldUnique > pairTerm.length) {
        const size = Math.max(pairTerm.length * 2, pairs + fieldUnique);
        pairTerm = growU32(pairTerm, size);
        pairCount = growU32(pairCount, size);
      }
      for (let j = 0; j < fieldUnique; j++) {
        const t = fieldList[j]!;
        pairTerm[pairs] = t;
        pairCount[pairs++] = count[t]!;
      }
      fieldEnd[f] = pairs;
      this.lens[doc * F + f] = n;
      this.totalLens[f]! += n;
      this.totalPostings += fieldUnique;
    }
    // The doc's sorted unique terms go to the delta arena; each field's frequencies to the slot of their term.
    const base = this.reserveDelta(docUnique);
    const fwd = this.dFwd;
    for (let i = 0; i < docUnique; i++) fwd[base + i] = docList[i]!;
    const own = fwd.subarray(base, base + docUnique);
    own.sort();
    const slot = tfCount; // free again: the counts are in the pairs; reused as term → slot in the doc's list
    for (let i = 0; i < docUnique; i++) {
      const t = own[i]!;
      slot[t] = i;
      this.ensureTerm(t);
      if (this.df[t]!++ === 0) this.liveTerms++;
    }
    const tfs = this.dTf;
    let p = 0;
    for (let f = 0; f < F; f++) {
      for (const end = fieldEnd[f]!; p < end; p++) {
        const t = pairTerm[p]!;
        const c = pairCount[p]!;
        const at = (base + slot[t]!) * F + f;
        if (c < TF_ESCAPE) tfs[at] = c;
        else {
          tfs[at] = TF_ESCAPE;
          this.bigTf.set((t * F + f) * DOC_SPAN + doc, c > 65_535 ? 65_535 : c);
        }
      }
    }
    if (this.dHead !== null) this.link(own, base, doc);
    this.fwdStart[doc] = base;
    this.fwdLen[doc] = docUnique;
    this.where[doc] = DELTA;
    if (this.deltaN === this.deltaDocs.length) this.deltaDocs = growI32(this.deltaDocs, this.deltaN * 2);
    this.deltaDocs[this.deltaN++] = doc;
    this.live++;
    if (this.deltaN >= this.deltaCap) this.freeze(false);
    return doc;
  }

  remove(doc: number): void {
    if (doc < 0 || doc >= this.docs) return;
    const at = this.where[doc]!;
    if (at !== FROZEN && at !== DELTA) return;
    this.where[doc] = at === FROZEN ? FROZEN_DEAD : DELTA_DEAD;
    const F = this.fields;
    const len = this.fwdLen[doc]!;
    const start = this.fwdStart[doc]!;
    const terms = at === FROZEN ? this.fFwd : this.dFwd;
    for (let i = start; i < start + len; i++) if (--this.df[terms[i]!]! === 0) this.liveTerms--;
    for (let f = 0; f < F; f++) this.totalLens[f]! -= this.lens[doc * F + f]!;
    this.live--;
    this.deadPostings += len; // at least this many postings died (a term may sit in several fields)
    this.pendingFree.push(doc);
    if (this.deadPostings > 64 && this.deadPostings * 10 > this.totalPostings) this.freeze(true);
  }

  /**
   * Compacts now if any removed doc's postings are still held, so every term no live doc holds is freed
   * (`onTermFreed`) before this returns. Removal compacts on its own once dead postings pass ~10%; this is for a
   * caller that must know nothing of what it removed is left (a revoked source).
   */
  flush(): void {
    if (this.pendingFree.length > 0) this.freeze(true);
  }

  /** The doc's sorted unique term ids (all fields). A view or a copy: callers must not write to it. */
  termsOf(doc: number): Uint32Array {
    if (doc < 0 || doc >= this.docs) return EMPTY;
    const at = this.where[doc]!;
    if (at === FREE) return EMPTY;
    const start = this.fwdStart[doc]!;
    const end = start + this.fwdLen[doc]!;
    // Arenas are never written in place once a doc's terms are in them (a freeze builds new ones), so a view stays
    // valid; a Uint16 arena is widened by a copy.
    const terms = at === FROZEN || at === FROZEN_DEAD ? this.fFwd : this.dFwd;
    return terms instanceof Uint32Array ? terms.subarray(start, end) : Uint32Array.from(terms.subarray(start, end));
  }

  /** True if the doc contains every term in `ids[0..n)` (binary search over its sorted term set). */
  containsAll(doc: number, ids: ArrayLike<number>, n: number): boolean {
    if (doc < 0 || doc >= this.docs) return false;
    const at = this.where[doc]!;
    if (at !== FROZEN && at !== DELTA) return false;
    const terms = at === FROZEN ? this.fFwd : this.dFwd;
    const start = this.fwdStart[doc]!;
    const end = start + this.fwdLen[doc]!;
    for (let i = 0; i < n; i++) if (find(terms, start, end, ids[i]!) < 0) return false;
    return true;
  }

  /** Inverse document frequency of a term among live docs (BM25 with the +1 that keeps it positive). */
  idf(term: number): number {
    const n = term < this.df.length ? this.df[term]! : 0;
    return Math.log(1 + (this.live - n + 0.5) / (n + 0.5));
  }

  /**
   * Top `k` live docs for the query's term ids `query[0..n)` (duplicates ignored). Terms no live doc holds are left
   * out of coverage: they say nothing about any doc, and counting them would punish a long query.
   */
  search(query: ArrayLike<number>, n: number, k: number): SearchResults {
    const results: SearchResults = {
      count: 0,
      docs: new Int32Array(0),
      scores: new Float64Array(0),
      coverage: new Float32Array(0),
      matched: new Uint8Array(0),
    };
    if (this.live === 0 || n === 0) return results;
    if (acc.length < this.docs) growDocScratch(this.docs);
    const F = this.fields;
    const k1 = this.k1;
    const k1p1 = k1 + 1;
    const delta = this.delta;
    const sAcc = acc;
    const sCov = cov;
    const sHit = hit;
    const sStamp = stamp;
    const sTouched = touched;
    const where = this.where;
    const lens = this.lens;
    const fKeys = this.fKeys;
    const keyStart = this.keyStart;
    const fDocs = this.fDocs;
    const fTfs = this.fTfs;
    const deltaN = this.deltaN;
    const deltaDocs = this.deltaDocs;
    const dFwd = this.dFwd;
    const dTf = this.dTf;
    const fwdStart = this.fwdStart;
    const fwdLen = this.fwdLen;
    const chained = this.dHead !== null;
    const dDoc = this.dDoc;
    const dHead = this.dHead;
    const dNext = this.dNext;
    let touchedN = 0;
    let totalIdf = 0;
    if (queryNo > 0xffff_ffff - n - 1) {
      // Stamps are Uint32: before the counter wraps, clear them so an old stamp can never equal a new one.
      stamp.fill(0);
      queryNo = 0;
    }
    if (termQueryNo > 0xffff_fff0) {
      queryTermStamp.fill(0);
      termQueryNo = 0;
    }
    if (queryTermStamp.length < this.df.length) queryTermStamp = growU32(queryTermStamp, this.df.length);
    const queryMark = ++termQueryNo;
    const termStamp = queryTermStamp;
    for (let q = 0; q < n; q++) {
      const t = query[q]!;
      if (t >= this.df.length || this.df[t] === 0) continue;
      if (termStamp[t] === queryMark) continue; // a repeated query term counts once
      termStamp[t] = queryMark;
      const idf = this.idf(t);
      totalIdf += idf;
      const mark = ++queryNo; // count coverage and matches once per doc for this term
      // The live delta docs that hold the term, found once for all fields: by its chain (newest first, so read
      // backwards below) or by a binary search in each delta doc's terms (oldest first).
      let inDelta = 0;
      if (chained) {
        if (t < dHead!.length) {
          let m = 0;
          for (let p = dHead![t]!; p >= 0; p = dNext[p]!) {
            const d = dDoc[p]!;
            if (where[d] !== DELTA) continue;
            hitPos[m] = p;
            hitDoc[m++] = d;
          }
          inDelta = m;
        }
      } else {
        for (let j = 0; j < deltaN; j++) {
          const d = deltaDocs[j]!;
          if (where[d] !== DELTA) continue;
          const at = find(dFwd, fwdStart[d]!, fwdStart[d]! + fwdLen[d]!, t);
          if (at < 0) continue;
          hitPos[inDelta] = at;
          hitDoc[inDelta++] = d;
        }
      }
      for (let f = 0; f < F; f++) {
        const key = t * F + f;
        const avg = this.totalLens[f]! / this.live || 1;
        const A = k1 * (1 - this.b[f]!);
        const B = (k1 * this.b[f]!) / avg;
        const w = this.weights[f]! * idf;
        // Frozen postings first: every frozen doc was added before every delta doc.
        if (key < fKeys) {
          const end = keyStart[key + 1]!;
          for (let i = keyStart[key]!; i < end; i++) {
            const d = fDocs[i]!;
            if (where[d] !== FROZEN) continue;
            let tf = fTfs[i]!;
            if (tf === TF_ESCAPE) tf = this.bigTf.get(key * DOC_SPAN + d)!;
            if (sHit[d] === 0) sTouched[touchedN++] = d;
            sAcc[d]! += w * ((tf * k1p1) / (tf + A + B * lens[d * F + f]!) + delta);
            if (sStamp[d] !== mark) {
              sStamp[d] = mark;
              sCov[d]! += idf;
              sHit[d]!++;
            }
          }
        }
        for (let i = 0; i < inDelta; i++) {
          const j = chained ? inDelta - 1 - i : i; // oldest first
          let tf = dTf[hitPos[j]! * F + f]!;
          if (tf === 0) continue; // the term is in another of the doc's fields
          const d = hitDoc[j]!;
          if (tf === TF_ESCAPE) tf = this.bigTf.get(key * DOC_SPAN + d)!;
          if (sHit[d] === 0) sTouched[touchedN++] = d;
          sAcc[d]! += w * ((tf * k1p1) / (tf + A + B * lens[d * F + f]!) + delta);
          if (sStamp[d] !== mark) {
            sStamp[d] = mark;
            sCov[d]! += idf;
            sHit[d]!++;
          }
        }
      }
    }
    const top = new TopK(Math.max(1, k));
    for (let i = 0; i < touchedN; i++) top.push(sTouched[i]!, sAcc[sTouched[i]!]!);
    const count = top.size;
    results.count = count;
    results.docs = new Int32Array(count);
    results.scores = new Float64Array(count);
    top.drain(results.docs, results.scores);
    results.coverage = new Float32Array(count);
    results.matched = new Uint8Array(count);
    for (let j = 0; j < count; j++) {
      const d = results.docs[j]!;
      results.coverage[j] = totalIdf > 0 ? sCov[d]! / totalIdf : 0;
      results.matched[j] = Math.min(sHit[d]!, 255); // matched is a Uint8 count: 255 means "255 or more"
    }
    for (let i = 0; i < touchedN; i++) {
      const d = sTouched[i]!;
      sAcc[d] = 0;
      sCov[d] = 0;
      sHit[d] = 0;
    }
    return results;
  }

  private allocateDoc(): number {
    const reused = this.freeDocs.pop();
    if (reused !== undefined) return reused;
    // `bigTf` keys pack a doc number into 22 bits: past that a key would collide with the next one's.
    if (this.docs >= DOC_SPAN) throw new RangeError(`SparseIndex holds at most ${DOC_SPAN} doc numbers`);
    const doc = this.docs++;
    if (doc >= this.where.length) {
      const size = this.where.length * 2;
      this.lens = growF32(this.lens, size * this.fields);
      this.where = growU8(this.where, size);
      this.fwdStart = growU32(this.fwdStart, size);
      this.fwdLen = growU32(this.fwdLen, size);
    }
    return doc;
  }

  private ensureTerm(t: number): void {
    if (t < this.df.length) return;
    let size = this.df.length;
    while (size <= t) size *= 2;
    this.df = growU32(this.df, size);
  }

  /** Room for `n` more terms in the delta arena; returns where they start. Grows by copying, never in place. */
  private reserveDelta(n: number): number {
    const at = this.dUsed;
    if (at + n > this.dFwd.length) {
      const size = Math.max(64, this.dFwd.length * 2, at + n);
      this.dFwd = growU32(this.dFwd, size);
      this.dTf = growU8(this.dTf, size * this.fields);
      if (this.dHead !== null) {
        this.dNext = growI32(this.dNext, size);
        this.dDoc = growI32(this.dDoc, size);
      }
    }
    this.dUsed = at + n;
    return at;
  }

  /** Chains a delta doc's terms (`own`, at arena position `base`) in front of each term's older occurrences. */
  private link(own: Uint32Array, base: number, doc: number): void {
    let head = this.dHead!;
    const last = own.length > 0 ? own[own.length - 1]! : 0;
    if (last >= head.length) {
      let size = head.length;
      while (size <= last) size *= 2;
      const grown = new Int32Array(size).fill(-1);
      grown.set(head);
      this.dHead = head = grown;
    }
    const next = this.dNext;
    const docOf = this.dDoc;
    for (let i = 0; i < own.length; i++) {
      const t = own[i]!;
      next[base + i] = head[t]!;
      docOf[base + i] = doc;
      head[t] = base + i;
    }
  }

  /**
   * Merges the delta into new frozen arrays. With `purge`, also drops every removed doc's postings and terms, frees
   * their doc numbers and reports each of their terms no live doc holds (`onTermFreed`): the reference's compaction.
   */
  private freeze(purge: boolean): void {
    const F = this.fields;
    const where = this.where;
    const fwdStart = this.fwdStart;
    const fwdLen = this.fwdLen;
    const dFwd = this.dFwd;
    const dTf = this.dTf;
    const oldKeys = this.fKeys;
    const oldStart = this.keyStart;
    const oldDocs = this.fDocs;
    const oldTfs = this.fTfs;
    const oldFwd = this.fFwd;
    // Sizes: keys up to the largest term a kept doc holds; doc and term widths from the largest number. Without a
    // purge every frozen doc is kept as it is, so only the delta's docs are read.
    let maxTerm = oldKeys / F - 1;
    let fwdTotal = oldFwd.length;
    if (purge) {
      maxTerm = -1;
      fwdTotal = 0;
      for (let d = 0; d < this.docs; d++) {
        const at = where[d]!;
        if (at !== FROZEN && at !== DELTA) continue;
        const len = fwdLen[d]!;
        fwdTotal += len;
        if (len > 0) {
          const last = (at === FROZEN ? oldFwd : dFwd)[fwdStart[d]! + len - 1]!;
          if (last > maxTerm) maxTerm = last;
        }
      }
    } else {
      for (let j = 0; j < this.deltaN; j++) {
        const d = this.deltaDocs[j]!;
        const len = fwdLen[d]!;
        fwdTotal += len;
        if (len > 0 && dFwd[fwdStart[d]! + len - 1]! > maxTerm) maxTerm = dFwd[fwdStart[d]! + len - 1]!;
      }
    }
    const keys = purge ? (maxTerm + 1) * F : Math.max(oldKeys, (maxTerm + 1) * F);
    // Keys a removed frozen doc holds: only these lose postings in a purge (all of a key's postings are filtered).
    const copyKeys = oldKeys < keys ? oldKeys : keys;
    let dirty: Uint8Array | null = null;
    if (purge) {
      dirty = new Uint8Array(copyKeys);
      for (const doc of this.pendingFree) {
        if (where[doc] !== FROZEN_DEAD) continue;
        const e = fwdStart[doc]! + fwdLen[doc]!;
        for (let i = fwdStart[doc]!; i < e; i++) {
          const base = oldFwd[i]! * F;
          for (let f = 0; f < F && base + f < copyKeys; f++) dirty[base + f] = 1;
        }
      }
    }
    // Per key: postings kept from the frozen tier, then the delta's live docs' postings.
    const start = new Uint32Array(keys + 1);
    let purged = 0;
    for (let key = 0; key < copyKeys; key++) {
      const a = oldStart[key]!;
      const b = oldStart[key + 1]!;
      if (dirty === null || dirty[key] === 0) {
        start[key + 1] = b - a;
        continue;
      }
      let kept = 0;
      for (let i = a; i < b; i++) if (where[oldDocs[i]!] === FROZEN) kept++;
      start[key + 1] = kept;
      purged += b - a - kept;
    }
    // Keys past the new end hold only purged postings (no kept doc holds a term that large).
    if (purge) for (let key = copyKeys; key < oldKeys; key++) purged += oldStart[key + 1]! - oldStart[key]!;
    for (let j = 0; j < this.deltaN; j++) {
      const d = this.deltaDocs[j]!;
      const s = fwdStart[d]!;
      const e = s + fwdLen[d]!;
      if (where[d] !== DELTA) {
        // A removed delta doc: its postings were counted in `totalPostings` and are never written.
        let n = 0;
        for (let i = s * F; i < e * F; i++) if (dTf[i] !== 0) n++;
        if (purge) purged += n;
        else this.droppedDead += n;
        continue;
      }
      for (let i = s; i < e; i++) {
        const base = dFwd[i]! * F;
        for (let f = 0; f < F; f++) if (dTf[i * F + f] !== 0) start[base + f + 1]!++;
      }
    }
    for (let key = 0; key < keys; key++) start[key + 1]! += start[key]!;
    const total = start[keys]!;
    const docs: Docs = this.docs <= 65_536 ? new Uint16Array(total) : new Uint32Array(total);
    const tfs = new Uint8Array(total);
    // Write cursor per key: frozen postings in order, then delta postings appended behind them. A key that neither
    // loses nor gains postings keeps its own and only moves by the keys before it: each run of such keys is copied
    // in one block; a dirty key's postings are filtered one by one.
    const cursor = start.slice(0, keys);
    let from = 0;
    for (let key = 0; key < copyKeys; key++) {
      const a = oldStart[key]!;
      const b = oldStart[key + 1]!;
      const isDirty = dirty !== null && dirty[key] === 1;
      if (!isDirty && start[key + 1]! - start[key]! === b - a) {
        cursor[key]! += b - a;
        continue;
      }
      const at = start[key]!;
      if (from < a) {
        docs.set(oldDocs.subarray(from, a), from + at - a);
        tfs.set(oldTfs.subarray(from, a), from + at - a);
      }
      if (isDirty) {
        let w = at;
        for (let i = a; i < b; i++) {
          const d = oldDocs[i]!;
          if (where[d] !== FROZEN) continue;
          docs[w] = d;
          tfs[w++] = oldTfs[i]!;
        }
        cursor[key] = w;
      } else {
        docs.set(oldDocs.subarray(a, b), at);
        tfs.set(oldTfs.subarray(a, b), at);
        cursor[key] = at + b - a;
      }
      from = b;
    }
    const end = oldStart[copyKeys]!;
    if (from < end) {
      const at = from + start[copyKeys]! - end; // the run's keys end where key copyKeys starts
      docs.set(oldDocs.subarray(from, end), at);
      tfs.set(oldTfs.subarray(from, end), at);
    }
    for (let j = 0; j < this.deltaN; j++) {
      const d = this.deltaDocs[j]!;
      if (where[d] !== DELTA) continue;
      const e = fwdStart[d]! + fwdLen[d]!;
      for (let i = fwdStart[d]!; i < e; i++) {
        const base = dFwd[i]! * F;
        for (let f = 0; f < F; f++) {
          const tf = dTf[i * F + f]!;
          if (tf === 0) continue;
          const w = cursor[base + f]!++;
          docs[w] = d;
          tfs[w] = tf;
        }
      }
    }
    // The forward arena: every kept doc's terms, frozen docs first (in place when nothing is purged).
    const fwd: Terms = maxTerm < 65_536 ? new Uint16Array(fwdTotal) : new Uint32Array(fwdTotal);
    let w = 0;
    if (purge) {
      for (let d = 0; d < this.docs; d++) {
        if (where[d] !== FROZEN) continue;
        const s = fwdStart[d]!;
        const e = s + fwdLen[d]!;
        fwdStart[d] = w;
        for (let i = s; i < e; i++) fwd[w++] = oldFwd[i]!;
      }
    } else {
      fwd.set(oldFwd);
      w = oldFwd.length;
    }
    for (let j = 0; j < this.deltaN; j++) {
      const d = this.deltaDocs[j]!;
      if (purge && where[d] === DELTA_DEAD) continue;
      const s = fwdStart[d]!;
      fwd.set(dFwd.subarray(s, s + fwdLen[d]!), w);
      fwdStart[d] = w;
      w += fwdLen[d]!;
      where[d] = where[d] === DELTA ? FROZEN : FROZEN_DEAD;
    }
    this.fKeys = keys;
    this.keyStart = start;
    this.fDocs = docs;
    this.fTfs = tfs;
    // The delta is empty from here. Its size follows the index; chained when a scan of it could be long.
    this.deltaN = 0;
    this.deltaCap = Math.min(MAX_DELTA_DOCS, Math.max(DELTA_DOCS, this.live >> 3));
    if (this.deltaCap <= DELTA_DOCS) this.dHead = null;
    else if (this.dHead === null) this.dHead = new Int32Array(Math.max(16, this.df.length)).fill(-1);
    else for (let i = 0; i < this.dUsed; i++) this.dHead[dFwd[i]!] = -1;
    this.dNext = new Int32Array(0);
    this.dDoc = new Int32Array(0);
    this.dFwd = new Uint32Array(0); // a new arena: termsOf views into the old one stay as they were
    this.dTf = new Uint8Array(0);
    this.dUsed = 0;
    if (!purge) {
      this.fFwd = fwd;
      return;
    }
    // The removed docs: their distinct terms (for `onTermFreed`, in the reference's order: first seen first, marked
    // with the insert scratch's doc stamp), their big frequencies, their slots.
    if (stampNo > 0xffff_fff0) {
      tfStamp.fill(0);
      docStamp.fill(0);
      stampNo = 0;
    }
    const mark = ++stampNo;
    const seen = docStamp; // sized past every term id ever added
    let removedTerms = 0;
    for (const doc of this.pendingFree) removedTerms += fwdLen[doc]!;
    const terms = new Uint32Array(removedTerms);
    let termsN = 0;
    for (const doc of this.pendingFree) {
      const s = fwdStart[doc]!;
      const e = s + fwdLen[doc]!;
      const own = where[doc] === FROZEN_DEAD ? oldFwd : dFwd;
      for (let i = s; i < e; i++) {
        const t = own[i]!;
        if (seen[t] !== mark) {
          seen[t] = mark;
          terms[termsN++] = t;
        }
        if (this.bigTf.size > 0) for (let f = 0; f < F; f++) this.bigTf.delete((t * F + f) * DOC_SPAN + doc);
      }
      where[doc] = FREE;
      fwdStart[doc] = 0;
      fwdLen[doc] = 0;
      this.freeDocs.push(doc);
    }
    this.fFwd = fwd;
    this.totalPostings -= purged + this.droppedDead;
    this.droppedDead = 0;
    this.deadPostings = 0;
    this.pendingFree = [];
    // Last: no doc number or posting names these terms now, so the callback may release them at once.
    const freed = this.onTermFreed;
    if (freed !== undefined) for (let i = 0; i < termsN; i++) if (this.df[terms[i]!] === 0) freed(terms[i]!);
  }
}

/** Position of `x` in the sorted `a[lo..hi)`, or -1. */
function find(a: Terms, lo: number, hi: number, x: number): number {
  hi--;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = a[mid]!;
    if (v === x) return mid;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function growU32(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}
function growI32(a: Int32Array, n: number): Int32Array {
  const b = new Int32Array(n);
  b.set(a);
  return b;
}
function growF32(a: Float32Array, n: number): Float32Array {
  const b = new Float32Array(n);
  b.set(a);
  return b;
}
function growU8(a: Uint8Array, n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set(a);
  return b;
}
