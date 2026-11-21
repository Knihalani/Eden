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
 * Freezing merges the delta into new frozen arrays, keeping each key's postings in insertion order (a doc number is
 * reused only after it is freed, and only a freed doc's postings are filtered out, so frozen postings are older than
 * delta docs). It starts when the delta is full (`DELTA_DOCS`, then an eighth of the index up to `MAX_DELTA_DOCS`)
 * and is incremental (D120): the full delta is sealed, later adds go behind it, and each add or remove does a bounded
 * share of the merge (`mergeStep`) until the new arrays replace the old in one swap; until then queries read the old
 * frozen tier and the whole delta, sealed part first. A merge within one step's work (`MERGE_MIN_WORK`, allocation
 * counted) finishes in the add that starts it.
 *
 * Removal marks a doc dead (skipped when scoring) and updates df and lengths at once. When dead postings reach ~10% of
 * all postings (or on `flush`), exactly where the reference compacted, the dead docs are purged: their numbers are
 * freed for reuse, each term no live doc holds any more is reported (`onTermFreed`), and they leave the delta. Their
 * frozen postings stay where they are, stale (a freed doc is neither frozen nor live, so scoring skips them), until
 * the next merge filters them out (a purge that leaves any, with no merge under way, starts one); a reused doc
 * number becomes frozen only in a merge that has filtered its stale postings, so none come back. A purge costs the
 * dead docs' terms and the delta, not a pass over every posting.
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

/**
 * A compacted index as arrays (`SparseIndex.snapshot`, D860): a frozen user's blob carries it so a thaw does not
 * tokenize and index every item again. `fDocs` and `fFwd` keep their width (Uint16 while numbers fit).
 */
export interface IndexSnapshot {
  fields: number;
  docs: number;
  live: number;
  keys: number;
  totalPostings: number;
  liveTerms: number;
  deltaCap: number;
  chained: boolean;
  totalLens: Float64Array;
  df: Uint32Array;
  lens: Float32Array;
  where: Uint8Array;
  fwdStart: Uint32Array;
  fwdLen: Uint32Array;
  nPost: Uint32Array;
  keyStart: Uint32Array;
  fDocs: Uint16Array | Uint32Array;
  fTfs: Uint8Array;
  fFwd: Uint16Array | Uint32Array;
  /** `bigTf` as (key, frequency) pairs. */
  bigTf: Float64Array;
  freeDocs: Int32Array;
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

/**
 * Merge work (about one unit per posting read or written, per key, per forward-arena slot, per 8 bytes of new arrays
 * zeroed) one add or remove does while a merge is under way: about this (0.1-0.2 ms warm,
 * bench/index-memory.bench.ts), so a merge holds its old and new arrays together for few adds (about 130 at 6,892
 * docs); or, for a far larger index, enough to finish within half the delta's capacity in adds, well before the
 * delta behind it fills (when it would, the merge is finished at once).
 */
const MERGE_MIN_WORK = 8_192;

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
// The delta holds up to twice its capacity while a merge is under way (the sealed part and the docs behind it).
const hitPos = new Int32Array(2 * MAX_DELTA_DOCS);
const hitDoc = new Int32Array(2 * MAX_DELTA_DOCS);

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

/** A merge under way (`SparseIndex.seal`): what it reads, fixed at the seal, and how far it has got. */
interface Merge {
  phase: number;
  /** Key or doc cursor within the phase. */
  at: number;
  /** Work per add or remove. */
  budget: number;
  keys: number;
  copyKeys: number;
  /** Doc numbers at the seal (every doc this merge writes is below it). */
  docCount: number;
  // The old frozen tier.
  oldStart: Uint32Array;
  oldDocs: Docs;
  oldTfs: Uint8Array;
  oldFwd: Terms;
  /** Per doc number: freed before the seal, its old frozen postings are dropped. Per term: some such doc held it. */
  staleDoc: Uint8Array | null;
  staleTerms: Uint8Array | null;
  // Frozen docs carried over (live or dead, not freed): their slices of the old forward arena.
  carry: Int32Array;
  carryStart: Uint32Array;
  carryLen: Uint32Array;
  carryPos: Uint32Array;
  // The sealed delta: its docs in order, their slices of its arena, live at the seal (only those get postings).
  sealed: Int32Array;
  sealedStart: Uint32Array;
  sealedLen: Uint32Array;
  sealedLive: Uint8Array;
  sealedPos: Uint32Array;
  sFwd: Uint32Array;
  sTf: Uint8Array;
  // The new frozen tier, being built.
  start: Uint32Array;
  docs: Docs;
  tfs: Uint8Array;
  cursor: Uint32Array;
  wideFwd: boolean;
  fwdTotal: number;
  fwd: Terms;
  fwdAt: number;
}

// Merge phases, in order.
const COUNT_FROZEN = 0;
const COUNT_SEALED = 1;
const PREFIX = 2;
const ALLOCATE = 3;
const COPY_FROZEN = 4;
const WRITE_SEALED = 5;
const FORWARD = 6;
const SWAP = 7;

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
  // The reference's posting counters, kept exactly so a purge (and so `onTermFreed`) runs where its compaction did.
  private deadPostings = 0;
  private totalPostings = 0;
  // Per doc: its postings ((term, field) pairs), what a purge takes off `totalPostings`.
  private nPost: Uint32Array = new Uint32Array(16);
  // Term ids some live doc holds (df > 0).
  private liveTerms = 0;
  private freeDocs: number[] = [];
  private pendingFree: number[] = [];
  /**
   * Doc numbers freed since the last seal whose postings a frozen tier still holds (or the merge under way will
   * write), and the terms those docs held: the next merge filters their postings out.
   */
  private staleDocs: number[] = [];
  private staleTerms: Uint8Array | null = null;
  private merge: Merge | null = null;
  /** The first `sealedN` delta docs are the merge's (sealed); the rest came after. */
  private sealedN = 0;

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

  /** What `compact` would merge: delta docs and removed docs not yet purged (0 once compacted, until a change). */
  get compactWork(): number {
    return this.deltaN + this.pendingFree.length;
  }

  /** Distinct term ids that some live doc holds. */
  get termCount(): number {
    return this.liveTerms;
  }

  /** Whether some live doc holds this term. */
  hasTerm(term: number): boolean {
    return term < this.df.length && this.df[term]! > 0;
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
    let posts = 0;
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
      posts += fieldUnique;
    }
    this.nPost[doc] = posts;
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
    if (this.merge !== null) this.mergeStep(this.merge.budget);
    if (this.deltaN - this.sealedN >= this.deltaCap) {
      // The delta behind a merge is full: finish that merge at once (rare: a merge's budget ends it sooner).
      if (this.merge !== null) this.mergeStep(Infinity);
      this.seal();
      this.mergeStep(this.merge!.budget);
    }
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
    if (this.deadPostings > 64 && this.deadPostings * 10 > this.totalPostings) this.purge();
    else if (this.merge !== null) this.mergeStep(this.merge.budget);
  }

  /**
   * Compacts now if any removed doc's postings are still held, so every term no live doc holds is freed
   * (`onTermFreed`) before this returns. Removal compacts on its own once dead postings pass ~10%; this is for a
   * caller that must know nothing of what it removed is left (a revoked source).
   */
  flush(): void {
    if (this.pendingFree.length > 0) this.purge();
    // And their postings, which a purge leaves stale until the next merge: one now, after the one under way.
    this.settle();
    if (this.staleDocs.length > 0) {
      this.seal();
      this.mergeStep(Infinity);
    }
  }

  /**
   * Finishes the merge under way, if any, at once. A merge holds the old frozen arrays and the new ones together
   * until it ends, which adds and removes bring about; an index that stops changing mid-merge would hold both, so its
   * owner calls this when the index is idle (the engine's expiry tick).
   */
  settle(): void {
    if (this.merge !== null) this.mergeStep(Infinity);
  }

  /**
   * Merges everything into the frozen tier now and lets go of the delta's spare room (D860): the removed docs are
   * purged, the merge under way finished, the whole delta (however few docs) sealed and merged, and the delta's
   * arrays cut to their minimum. For an index that has gone idle (the engine's idle tick, and before a `snapshot`):
   * a heavy index's delta holds up to an eighth of its docs at about three times a frozen doc's bytes, plus room
   * to grow. Results are unchanged (frozen postings keep insertion order, frozen before delta).
   */
  compact(): void {
    const done = this.deltaN === 0 && this.dFwd.length === 0 && this.merge === null;
    if (done && this.pendingFree.length === 0 && this.staleDocs.length === 0) return;
    if (this.pendingFree.length > 0) this.purge();
    this.settle();
    if (this.deltaN > 0 || this.staleDocs.length > 0) {
      this.seal();
      this.mergeStep(Infinity);
    }
    // The delta is empty: its arrays at their floor (`rebuildDelta` left at least 64 slots, and a chain head per
    // term id; `link` grows the head again as terms arrive).
    this.dFwd = new Uint32Array(0);
    this.dTf = new Uint8Array(0);
    this.dUsed = 0;
    this.deltaDocs = new Int32Array(16);
    if (this.dHead !== null) {
      this.dHead = new Int32Array(16).fill(-1);
      this.dNext = new Int32Array(0);
      this.dDoc = new Int32Array(0);
    }
    this.staleTerms = null;
  }

  /**
   * The index as typed arrays and numbers (a frozen user's blob, D860), after `compact`: `SparseIndex.restore`
   * rebuilds it, doc numbers and all, with no tokenizing and no merge. The arrays are copies cut to their used length.
   */
  snapshot(): IndexSnapshot {
    this.compact();
    const F = this.fields;
    const n = this.docs;
    const keys = this.fKeys;
    const total = keys > 0 ? this.keyStart[keys]! : 0;
    let fwdTotal = 0;
    for (let d = 0; d < n; d++) {
      const end = this.fwdStart[d]! + this.fwdLen[d]!;
      if (end > fwdTotal && (this.where[d] === FROZEN || this.where[d] === FROZEN_DEAD)) fwdTotal = end;
    }
    let maxTerm = 0;
    for (let t = this.df.length - 1; t >= 0; t--) {
      if (this.df[t] !== 0) {
        maxTerm = t + 1;
        break;
      }
    }
    const big = new Float64Array(this.bigTf.size * 2);
    let i = 0;
    for (const [k, v] of this.bigTf) {
      big[i++] = k;
      big[i++] = v;
    }
    return {
      fields: F,
      docs: n,
      live: this.live,
      keys,
      totalPostings: this.totalPostings,
      liveTerms: this.liveTerms,
      deltaCap: this.deltaCap,
      chained: this.dHead !== null,
      totalLens: this.totalLens.slice(),
      df: this.df.slice(0, maxTerm),
      lens: this.lens.slice(0, n * F),
      where: this.where.slice(0, n),
      fwdStart: this.fwdStart.slice(0, n),
      fwdLen: this.fwdLen.slice(0, n),
      nPost: this.nPost.slice(0, n),
      keyStart: keys > 0 ? this.keyStart.slice(0, keys + 1) : new Uint32Array(0),
      fDocs: this.fDocs.slice(0, total),
      fTfs: this.fTfs.slice(0, total),
      fFwd: this.fFwd.slice(0, fwdTotal),
      bigTf: big,
      freeDocs: Int32Array.from(this.freeDocs),
    };
  }

  /**
   * The index `snapshot` saved (D860), with `options` as the index was built with (they are not saved: the caller's
   * own). Searches, adds and removes behave as on the index the snapshot was taken of.
   */
  static restore(s: IndexSnapshot, options: SparseIndexOptions = {}): SparseIndex {
    const x = new SparseIndex(options);
    if (s.fields !== x.fields) throw new RangeError("snapshot has another field count");
    const F = x.fields;
    const cap = Math.max(16, s.docs);
    x.docs = s.docs;
    x.live = s.live;
    x.fKeys = s.keys;
    x.totalPostings = s.totalPostings;
    x.liveTerms = s.liveTerms;
    x.deltaCap = s.deltaCap;
    x.totalLens.set(s.totalLens);
    x.df = new Uint32Array(Math.max(16, s.df.length));
    x.df.set(s.df);
    x.lens = new Float32Array(cap * F);
    x.lens.set(s.lens);
    x.where = new Uint8Array(cap);
    x.where.set(s.where);
    x.fwdStart = new Uint32Array(cap);
    x.fwdStart.set(s.fwdStart);
    x.fwdLen = new Uint32Array(cap);
    x.fwdLen.set(s.fwdLen);
    x.nPost = new Uint32Array(cap);
    x.nPost.set(s.nPost);
    x.keyStart = s.keys > 0 ? s.keyStart : EMPTY;
    x.fDocs = s.fDocs;
    x.fTfs = s.fTfs;
    x.fFwd = s.fFwd;
    for (let i = 0; i < s.bigTf.length; i += 2) x.bigTf.set(s.bigTf[i]!, s.bigTf[i + 1]!);
    x.freeDocs = Array.from(s.freeDocs);
    x.dFwd = new Uint32Array(0);
    x.dTf = new Uint8Array(0);
    if (s.chained) x.dHead = new Int32Array(16).fill(-1);
    // The shared scratch must reach past every term id the index holds (`purge` marks terms seen in it), as `add`
    // keeps it for terms it meets; a fresh process has seen none of these.
    if (s.df.length > 0 && s.df.length > tfCount.length) growScratch(s.df.length - 1);
    return x;
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
      this.nPost = growU32(this.nPost, size);
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
   * Purges the removed docs (the reference's compaction, at its points): frees their doc numbers, reports each of
   * their terms no live doc holds (`onTermFreed`) and drops them from the delta. Their frozen postings stay, stale,
   * for the next merge to filter out; so do those of a sealed doc, which the merge under way still writes.
   */
  private purge(): void {
    const F = this.fields;
    const where = this.where;
    const fwdStart = this.fwdStart;
    const fwdLen = this.fwdLen;
    // Their distinct terms, in the reference's order (first seen first, marked with the insert scratch's doc stamp).
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
      const frozen = where[doc] === FROZEN_DEAD;
      const own = frozen ? this.fFwd : this.dFwd;
      for (let i = s; i < e; i++) {
        const t = own[i]!;
        if (seen[t] !== mark) {
          seen[t] = mark;
          terms[termsN++] = t;
        }
        if (this.bigTf.size > 0) for (let f = 0; f < F; f++) this.bigTf.delete((t * F + f) * DOC_SPAN + doc);
      }
      if (frozen) this.markStale(doc, own, s, e);
      this.totalPostings -= this.nPost[doc]!;
      where[doc] = FREE;
    }
    // Out of the delta. A sealed doc's postings reach the new frozen tier, so they are stale there.
    let gone = false;
    for (let j = 0; j < this.deltaN; j++) {
      const d = this.deltaDocs[j]!;
      if (where[d] !== FREE) continue;
      gone = true;
      if (j < this.sealedN) this.markStale(d, this.dFwd, fwdStart[d]!, fwdStart[d]! + fwdLen[d]!);
    }
    // The delta's size follows the index, as after a merge (a merge under way sets it when it ends).
    if (this.merge === null) this.deltaCap = Math.min(MAX_DELTA_DOCS, Math.max(DELTA_DOCS, this.live >> 3));
    const chained = this.deltaCap > DELTA_DOCS;
    if (gone || chained !== (this.dHead !== null)) this.rebuildDelta(0, chained);
    for (const doc of this.pendingFree) {
      fwdStart[doc] = 0;
      fwdLen[doc] = 0;
      this.nPost[doc] = 0;
      this.freeDocs.push(doc);
    }
    this.deadPostings = 0;
    this.pendingFree = [];
    // Their frozen postings go in a merge started now (the reference's compaction rewrote at this point), done a step
    // at a time; with one under way, in the next.
    if (this.merge === null && this.staleDocs.length > 0) this.seal();
    // Last: no doc number or live posting names these terms now, so the callback may release them at once.
    const freed = this.onTermFreed;
    if (freed !== undefined) for (let i = 0; i < termsN; i++) if (this.df[terms[i]!] === 0) freed(terms[i]!);
  }

  /** Records a freed doc whose postings a frozen tier holds (or will), with its terms `own[s..e)`. */
  private markStale(doc: number, own: Terms, s: number, e: number): void {
    this.staleDocs.push(doc);
    let marks = this.staleTerms;
    if (marks === null || marks.length < this.df.length) {
      const grown = new Uint8Array(this.df.length);
      if (marks !== null) grown.set(marks);
      this.staleTerms = marks = grown;
    }
    for (let i = s; i < e; i++) marks[own[i]!] = 1;
  }

  /**
   * Rebuilds the delta from `deltaDocs[from..deltaN)`, keeping the docs `where` still has in it, in order: a new arena
   * (views into the old one stay valid) and, if `chained`, new chains. The sealed docs kept stay first.
   */
  private rebuildDelta(from: number, chained: boolean): void {
    const F = this.fields;
    const where = this.where;
    const fwdStart = this.fwdStart;
    const fwdLen = this.fwdLen;
    const docs = this.deltaDocs;
    const oldFwd = this.dFwd;
    const oldTf = this.dTf;
    const oldUsed = this.dUsed;
    let n = 0;
    let sealed = 0;
    let used = 0;
    for (let j = from; j < this.deltaN; j++) {
      const d = docs[j]!;
      const at = where[d]!;
      if (at !== DELTA && at !== DELTA_DEAD) continue;
      if (j < this.sealedN) sealed++;
      docs[n++] = d;
      used += fwdLen[d]!;
    }
    const size = Math.max(64, used);
    const fwd = new Uint32Array(size);
    const tf = new Uint8Array(size * F);
    let w = 0;
    for (let j = 0; j < n; j++) {
      const d = docs[j]!;
      const s = fwdStart[d]!;
      const len = fwdLen[d]!;
      fwd.set(oldFwd.subarray(s, s + len), w);
      tf.set(oldTf.subarray(s * F, (s + len) * F), w * F);
      fwdStart[d] = w;
      w += len;
    }
    this.dFwd = fwd;
    this.dTf = tf;
    this.dUsed = w;
    this.deltaN = n;
    this.sealedN = sealed;
    if (!chained) {
      this.dHead = null;
      this.dNext = new Int32Array(0);
      this.dDoc = new Int32Array(0);
      return;
    }
    if (this.dHead === null) this.dHead = new Int32Array(Math.max(16, this.df.length)).fill(-1);
    else for (let i = 0; i < oldUsed; i++) this.dHead[oldFwd[i]!] = -1;
    this.dNext = new Int32Array(size);
    this.dDoc = new Int32Array(size);
    for (let j = 0; j < n; j++) {
      const d = docs[j]!;
      this.link(fwd.subarray(fwdStart[d]!, fwdStart[d]! + fwdLen[d]!), fwdStart[d]!, d);
    }
  }

  /**
   * Starts a merge of the whole delta (sealed from here) into a new frozen tier: the old frozen docs not freed
   * (live or dead) are carried over, the postings of docs freed before now are dropped. No merge is under way.
   */
  private seal(): void {
    const F = this.fields;
    const where = this.where;
    const fwdStart = this.fwdStart;
    const fwdLen = this.fwdLen;
    const oldFwd = this.fFwd;
    const dFwd = this.dFwd;
    const docCount = this.docs;
    let staleDoc: Uint8Array | null = null;
    if (this.staleDocs.length > 0) {
      staleDoc = new Uint8Array(docCount);
      for (const d of this.staleDocs) staleDoc[d] = 1;
    }
    const staleTerms = this.staleTerms;
    this.staleDocs = [];
    this.staleTerms = null;
    let maxTerm = -1;
    let fwdTotal = 0;
    let carryN = 0;
    for (let d = 0; d < docCount; d++) {
      const at = where[d]!;
      if (at === FROZEN || at === FROZEN_DEAD) carryN++;
    }
    const carry = new Int32Array(carryN);
    const carryStart = new Uint32Array(carryN);
    const carryLen = new Uint32Array(carryN);
    carryN = 0;
    for (let d = 0; d < docCount; d++) {
      const at = where[d]!;
      if (at !== FROZEN && at !== FROZEN_DEAD) continue;
      const len = fwdLen[d]!;
      carry[carryN] = d;
      carryStart[carryN] = fwdStart[d]!;
      carryLen[carryN++] = len;
      fwdTotal += len;
      if (len > 0 && oldFwd[fwdStart[d]! + len - 1]! > maxTerm) maxTerm = oldFwd[fwdStart[d]! + len - 1]!;
    }
    const n = this.deltaN;
    const sealed = this.deltaDocs.slice(0, n);
    const sealedStart = new Uint32Array(n);
    const sealedLen = new Uint32Array(n);
    const sealedLive = new Uint8Array(n);
    let slots = 0;
    for (let j = 0; j < n; j++) {
      const d = sealed[j]!;
      const len = fwdLen[d]!;
      sealedStart[j] = fwdStart[d]!;
      sealedLen[j] = len;
      sealedLive[j] = where[d] === DELTA ? 1 : 0;
      fwdTotal += len;
      if (sealedLive[j] === 1) slots += len;
      if (len > 0 && dFwd[fwdStart[d]! + len - 1]! > maxTerm) maxTerm = dFwd[fwdStart[d]! + len - 1]!;
    }
    this.sealedN = n;
    const keys = (maxTerm + 1) * F;
    const oldKeys = this.fKeys;
    const oldTotal = oldKeys > 0 ? this.keyStart[oldKeys]! : 0;
    const work = 2 * oldTotal + 2 * keys + 2 * slots * F + fwdTotal;
    this.merge = {
      phase: COUNT_FROZEN,
      at: 0,
      budget: Math.max(MERGE_MIN_WORK, Math.ceil(work / Math.max(1, this.deltaCap >> 1))),
      keys,
      copyKeys: oldKeys < keys ? oldKeys : keys,
      docCount,
      oldStart: this.keyStart,
      oldDocs: this.fDocs,
      oldTfs: this.fTfs,
      oldFwd,
      staleDoc,
      staleTerms,
      carry,
      carryStart,
      carryLen,
      carryPos: new Uint32Array(carryN),
      sealed,
      sealedStart,
      sealedLen,
      sealedLive,
      sealedPos: new Uint32Array(n),
      sFwd: dFwd,
      sTf: this.dTf,
      start: new Uint32Array(keys + 1),
      docs: new Uint16Array(0),
      tfs: new Uint8Array(0),
      cursor: EMPTY,
      wideFwd: maxTerm >= 65_536,
      fwdTotal,
      fwd: EMPTY,
      fwdAt: 0,
    };
  }

  /** Does about `budget` units of the merge under way; the last step swaps the new frozen tier in. */
  private mergeStep(budget: number): void {
    const m = this.merge!;
    const F = this.fields;
    let work = 0;
    while (work < budget) {
      switch (m.phase) {
        case COUNT_FROZEN: {
          // Per key: its old postings, less a freed doc's in a key some freed doc held.
          const { oldStart, oldDocs, staleDoc, staleTerms, start } = m;
          let key = m.at;
          for (; key < m.copyKeys && work < budget; key++) {
            const a = oldStart[key]!;
            const b = oldStart[key + 1]!;
            const t = (key / F) | 0;
            work++;
            if (staleTerms === null || t >= staleTerms.length || staleTerms[t] === 0) {
              start[key + 1] = b - a;
              continue;
            }
            let kept = 0;
            for (let i = a; i < b; i++) if (staleDoc![oldDocs[i]!] !== 1) kept++;
            start[key + 1] = kept;
            work += b - a;
          }
          m.at = key;
          if (key === m.copyKeys) {
            m.phase = COUNT_SEALED;
            m.at = 0;
          }
          break;
        }
        case COUNT_SEALED: {
          const { sealedLive, sealedStart, sealedLen, sFwd, sTf, start } = m;
          let j = m.at;
          for (; j < sealedLive.length && work < budget; j++) {
            work++;
            if (sealedLive[j] === 0) continue;
            const e = sealedStart[j]! + sealedLen[j]!;
            for (let i = sealedStart[j]!; i < e; i++) {
              const base = sFwd[i]! * F;
              for (let f = 0; f < F; f++) if (sTf[i * F + f] !== 0) start[base + f + 1]!++;
            }
            work += sealedLen[j]! * F;
          }
          m.at = j;
          if (j === sealedLive.length) {
            m.phase = PREFIX;
            m.at = 0;
          }
          break;
        }
        case PREFIX: {
          const start = m.start;
          let key = m.at;
          for (; key < m.keys && work < budget; key++, work++) start[key + 1]! += start[key]!;
          m.at = key;
          if (key === m.keys) {
            m.phase = ALLOCATE;
            m.at = 0;
          }
          break;
        }
        case ALLOCATE: {
          // The new posting arrays: zeroing a large one is work too (and may start a collection), counted as such, so
          // a large index allocates them a step apart and a small one in the step that counts.
          const total = m.start[m.keys]!;
          if (m.at === 0) m.docs = m.docCount <= 65_536 ? new Uint16Array(total) : new Uint32Array(total);
          else if (m.at === 1) m.tfs = new Uint8Array(total);
          else m.cursor = m.start.slice(0, m.keys);
          work += 1 + ((m.at === 2 ? m.keys * 4 : m.at === 0 ? total * 2 : total) >> 3);
          if (++m.at === 3) {
            m.phase = COPY_FROZEN;
            m.at = 0;
          }
          break;
        }
        case COPY_FROZEN: {
          // Each key's kept old postings at its new start. Runs of whole keys at one shift are copied as one block.
          const { oldStart, oldDocs, oldTfs, staleDoc, staleTerms, start, docs, tfs, cursor } = m;
          let runFrom = -1;
          let runEnd = 0;
          let shift = 0;
          let key = m.at;
          for (; key < m.copyKeys && work < budget; key++) {
            const a = oldStart[key]!;
            const b = oldStart[key + 1]!;
            const at = start[key]!;
            const t = (key / F) | 0;
            work++;
            if (staleTerms !== null && t < staleTerms.length && staleTerms[t] === 1) {
              let w = at;
              for (let i = a; i < b; i++) {
                const d = oldDocs[i]!;
                if (staleDoc![d] === 1) continue;
                docs[w] = d;
                tfs[w++] = oldTfs[i]!;
              }
              cursor[key] = w;
              work += b - a;
              continue;
            }
            if (b === a) continue;
            if (runFrom < 0 || runEnd !== a || at - a !== shift) {
              if (runFrom >= 0) {
                docs.set(oldDocs.subarray(runFrom, runEnd), runFrom + shift);
                tfs.set(oldTfs.subarray(runFrom, runEnd), runFrom + shift);
              }
              runFrom = a;
              shift = at - a;
            }
            runEnd = b;
            cursor[key] = at + b - a;
            work += (b - a) >> 2;
          }
          if (runFrom >= 0) {
            docs.set(oldDocs.subarray(runFrom, runEnd), runFrom + shift);
            tfs.set(oldTfs.subarray(runFrom, runEnd), runFrom + shift);
          }
          m.at = key;
          if (key === m.copyKeys) {
            m.phase = WRITE_SEALED;
            m.at = 0;
          }
          break;
        }
        case WRITE_SEALED: {
          // The sealed docs' postings behind each key's old ones, in delta order.
          const { sealed, sealedLive, sealedStart, sealedLen, sFwd, sTf, docs, tfs, cursor } = m;
          let j = m.at;
          for (; j < sealed.length && work < budget; j++) {
            work++;
            if (sealedLive[j] === 0) continue;
            const d = sealed[j]!;
            const e = sealedStart[j]! + sealedLen[j]!;
            for (let i = sealedStart[j]!; i < e; i++) {
              const base = sFwd[i]! * F;
              for (let f = 0; f < F; f++) {
                const tf = sTf[i * F + f]!;
                if (tf === 0) continue;
                const w = cursor[base + f]!++;
                docs[w] = d;
                tfs[w] = tf;
              }
            }
            work += sealedLen[j]! * F;
          }
          m.at = j;
          if (j === sealed.length) {
            m.cursor = EMPTY;
            m.phase = FORWARD;
            m.at = 0;
          }
          break;
        }
        case FORWARD: {
          // The forward arena: the carried docs' terms, then the sealed docs'. Its allocation counts as work.
          if (m.fwd === EMPTY && m.fwdTotal > 0) {
            m.fwd = m.wideFwd ? new Uint32Array(m.fwdTotal) : new Uint16Array(m.fwdTotal);
            work += m.fwdTotal >> 3;
            continue;
          }
          const { carry, carryStart, carryLen, carryPos, sealed, sealedStart, sealedLen, sealedPos, fwd } = m;
          const carried = carry.length;
          let j = m.at;
          for (; j < carried + sealed.length && work < budget; j++) {
            const own = j < carried;
            const k = own ? j : j - carried;
            const s = own ? carryStart[k]! : sealedStart[k]!;
            const len = own ? carryLen[k]! : sealedLen[k]!;
            fwd.set((own ? m.oldFwd : m.sFwd).subarray(s, s + len), m.fwdAt);
            if (own) carryPos[k] = m.fwdAt;
            else sealedPos[k] = m.fwdAt;
            m.fwdAt += len;
            work += 1 + (len >> 2);
          }
          m.at = j;
          if (j === carried + sealed.length) m.phase = SWAP;
          break;
        }
        default:
          this.swap(m);
          return;
      }
    }
  }

  /**
   * Ends a merge: the new frozen tier replaces the old, the sealed docs become frozen and leave the delta. A doc
   * freed since the seal keeps its state (it is not frozen in the new tier; its postings there are stale).
   */
  private swap(m: Merge): void {
    const where = this.where;
    const fwdStart = this.fwdStart;
    let freed: Uint8Array | null = null;
    if (this.staleDocs.length > 0) {
      freed = new Uint8Array(this.docs);
      for (const d of this.staleDocs) freed[d] = 1;
    }
    for (let j = 0; j < m.carry.length; j++) {
      const d = m.carry[j]!;
      if (freed === null || freed[d] === 0) fwdStart[d] = m.carryPos[j]!;
    }
    for (let j = 0; j < m.sealed.length; j++) {
      const d = m.sealed[j]!;
      if (freed !== null && freed[d] === 1) continue;
      where[d] = where[d] === DELTA ? FROZEN : FROZEN_DEAD;
      fwdStart[d] = m.sealedPos[j]!;
    }
    this.fKeys = m.keys;
    this.keyStart = m.start;
    this.fDocs = m.docs;
    this.fTfs = m.tfs;
    this.fFwd = m.fwd;
    this.merge = null;
    // The docs behind the sealed ones are the delta now. Its size follows the index; chained when a scan could be long.
    this.deltaCap = Math.min(MAX_DELTA_DOCS, Math.max(DELTA_DOCS, this.live >> 3));
    this.rebuildDelta(this.sealedN, this.deltaCap > DELTA_DOCS);
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
