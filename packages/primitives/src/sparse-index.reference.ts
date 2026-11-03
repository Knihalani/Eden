/**
 * The reference: `SparseIndex` as it was before the packed layout (2026-11-03), kept unchanged as the oracle the
 * packed index must match result for result (`sparse-index.test.ts`) and as the "before" of its benchmarks
 * (`bench/index-memory.bench.ts`). Not exported from the package; nothing in the product uses it.
 *
 * An in-memory inverted index with BM25 scoring over term ids (from `Vocab`/`tokenizeInto`), for one user's cache.
 *
 * Layout: per (term, field), postings in two growable typed arrays (doc numbers, term frequencies); per doc, its field
 * lengths, a live flag and its sorted unique term ids (kept for removal, and so callers can test "does this doc contain
 * all of these terms" by binary search instead of re-tokenizing the text). Scoring is term-at-a-time into a reused
 * dense Float32Array accumulator plus a touched-docs list, then top-k: no per-query allocation beyond the result.
 *
 * Removal marks the doc dead (skipped when scoring) and updates df and lengths at once; postings of dead docs are
 * purged in one compaction pass when they reach ~10% of all postings, after which their doc numbers are reused.
 * Compaction also frees the posting arrays it emptied and reports each term no live doc holds any more
 * (`onTermFreed`): from then on nothing in the index refers to that term id, so its owner may release it
 * (`Vocab.release`) and the id may come back as another term.
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
 * Compared with MiniSearch, Orama, FlexSearch and wink-bm25 on a 6,000-item workload (docs/research/primitives.md):
 * fastest per query by 19–50x with the least memory. Field weights should be tuned on real labels (ROADMAP M1), not
 * on synthetic data.
 */
import type { SearchResults, SparseIndexOptions } from "./sparse-index";
import { TopK } from "./topk";

const EMPTY = new Uint32Array(0);

// Insert and query scratch, indexed by term id, shared by every index: JavaScript runs one `addFields` or `search` at
// a time and neither yields, so one copy serves all (each per-user index held its own before: 24 bytes per term id
// of the user's vocabulary). Insert: per-field counts tagged with a stamp (no clearing, no hashing), the doc-level
// seen stamp and the touched-term lists; it replaced a Map and a Set per insert (bench/index.bench.ts). Query: the
// query that last held each term, so a repeated term is skipped in O(1). Stamps only grow and are shared, so a stamp
// left by one index never equals a later one of another.
let tfCount: Uint32Array = new Uint32Array(1_024);
let tfStamp: Uint32Array = new Uint32Array(1_024);
let docStamp: Uint32Array = new Uint32Array(1_024);
let stampNo = 0;
let fieldTouched: Uint32Array = new Uint32Array(1_024);
let docTouched: Uint32Array = new Uint32Array(1_024);
let queryTermStamp: Uint32Array = new Uint32Array(1_024);
let termQueryNo = 0;

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

export class ReferenceSparseIndex {
  private readonly k1: number;
  private readonly fields: number;
  private readonly b: Float64Array;
  private readonly weights: Float64Array;
  private readonly delta: number;
  private readonly onTermFreed: ((term: number) => void) | undefined;
  // Per term key (term × fields + field): postings.
  private postDocs: (Uint32Array | undefined)[] = [];
  private postTfs: (Uint16Array | undefined)[] = [];
  private postLen: Uint32Array = new Uint32Array(64);
  // Per term id: docs (any field) that hold it.
  private df: Uint32Array = new Uint32Array(64);
  // Per doc (× fields for lengths).
  private lens: Float32Array;
  private alive: Uint8Array = new Uint8Array(64);
  private docTerms: Uint32Array[] = [];
  private readonly totalLens: Float64Array;
  private docs = 0;
  private live = 0;
  private deadPostings = 0;
  private totalPostings = 0;
  // Term ids some live doc holds (df > 0).
  private liveTerms = 0;
  private freeDocs: number[] = [];
  private pendingFree: number[] = [];
  // Query scratch.
  private acc = new Float32Array(64);
  private cov = new Float32Array(64);
  // Per doc: distinct query terms matched (Uint32, so a long query cannot wrap it), and the term that last counted.
  private hit = new Uint32Array(64);
  private stamp = new Uint32Array(64);
  private touched = new Int32Array(64);
  private queryNo = 0;

  constructor(options: SparseIndexOptions = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.fields = Math.max(1, options.fields ?? 1);
    this.b = Float64Array.from({ length: this.fields }, (_, f) => options.b?.[f] ?? 0.75);
    this.weights = Float64Array.from({ length: this.fields }, (_, f) => options.weights?.[f] ?? 1);
    this.delta = options.delta ?? 0;
    this.onTermFreed = options.onTermFreed;
    this.totalLens = new Float64Array(this.fields);
    this.lens = new Float32Array(64 * this.fields);
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
    // The scratch in locals (module bindings read slower in a hot loop); reloaded when `growScratch` replaces it.
    let count = tfCount;
    let fieldStamp = tfStamp;
    let seen = docStamp;
    let fieldList = fieldTouched;
    let docList = docTouched;
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
      for (let j = 0; j < fieldUnique; j++) {
        const t = fieldList[j]!;
        const c = count[t]!;
        const key = t * F + f;
        this.ensureKey(key);
        this.append(key, doc, c > 65_535 ? 65_535 : c);
      }
      this.lens[doc * F + f] = n;
      this.totalLens[f]! += n;
      this.totalPostings += fieldUnique;
    }
    const unique = docList.slice(0, docUnique);
    unique.sort();
    for (let i = 0; i < docUnique; i++) {
      const t = unique[i]!;
      this.ensureTerm(t);
      if (this.df[t]!++ === 0) this.liveTerms++;
    }
    this.docTerms[doc] = unique;
    this.alive[doc] = 1;
    this.live++;
    return doc;
  }

  remove(doc: number): void {
    if (doc < 0 || doc >= this.docs || this.alive[doc] === 0) return;
    this.alive[doc] = 0;
    const terms = this.docTerms[doc]!;
    const F = this.fields;
    for (let i = 0; i < terms.length; i++) if (--this.df[terms[i]!]! === 0) this.liveTerms--;
    for (let f = 0; f < F; f++) this.totalLens[f]! -= this.lens[doc * F + f]!;
    this.live--;
    this.deadPostings += terms.length; // at least this many postings died (a term may sit in several fields)
    this.pendingFree.push(doc);
    if (this.deadPostings > 64 && this.deadPostings * 10 > this.totalPostings) this.compact();
  }

  /**
   * Compacts now if any removed doc's postings are still held, so every term no live doc holds is freed
   * (`onTermFreed`) before this returns. Removal compacts on its own once dead postings pass ~10%; this is for a
   * caller that must know nothing of what it removed is left (a revoked source).
   */
  flush(): void {
    if (this.pendingFree.length > 0) this.compact();
  }

  /** The doc's sorted unique term ids (all fields). */
  termsOf(doc: number): Uint32Array {
    return this.docTerms[doc] ?? EMPTY;
  }

  /** True if the doc contains every term in `ids[0..n)` (binary search over its sorted term set). */
  containsAll(doc: number, ids: ArrayLike<number>, n: number): boolean {
    const terms = this.docTerms[doc];
    if (terms === undefined || this.alive[doc] === 0) return false;
    for (let i = 0; i < n; i++) if (!has(terms, ids[i]!)) return false;
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
    const F = this.fields;
    const k1 = this.k1;
    const k1p1 = k1 + 1;
    const delta = this.delta;
    const acc = this.acc;
    const cov = this.cov;
    const hit = this.hit;
    const stamp = this.stamp;
    const touched = this.touched;
    const alive = this.alive;
    const lens = this.lens;
    let touchedN = 0;
    let totalIdf = 0;
    if (this.queryNo > 0xffff_ffff - n - 1) {
      // Stamps are Uint32: before the counter wraps, clear them so an old stamp can never equal a new one.
      this.stamp.fill(0);
      this.queryNo = 0;
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
      const mark = ++this.queryNo; // count coverage and matches once per doc for this term
      for (let f = 0; f < F; f++) {
        const key = t * F + f;
        if (key >= this.postLen.length) continue;
        const len = this.postLen[key]!;
        if (len === 0) continue;
        const avg = this.totalLens[f]! / this.live || 1;
        const A = k1 * (1 - this.b[f]!);
        const B = (k1 * this.b[f]!) / avg;
        const w = this.weights[f]! * idf;
        const docs = this.postDocs[key]!;
        const tfs = this.postTfs[key]!;
        for (let i = 0; i < len; i++) {
          const d = docs[i]!;
          if (alive[d] === 0) continue;
          const tf = tfs[i]!;
          if (hit[d] === 0) touched[touchedN++] = d;
          acc[d]! += w * ((tf * k1p1) / (tf + A + B * lens[d * F + f]!) + delta);
          if (stamp[d] !== mark) {
            stamp[d] = mark;
            cov[d]! += idf;
            hit[d]!++;
          }
        }
      }
    }
    const top = new TopK(Math.max(1, k));
    for (let i = 0; i < touchedN; i++) top.push(touched[i]!, acc[touched[i]!]!);
    const count = top.size;
    results.count = count;
    results.docs = new Int32Array(count);
    results.scores = new Float64Array(count);
    top.drain(results.docs, results.scores);
    results.coverage = new Float32Array(count);
    results.matched = new Uint8Array(count);
    for (let j = 0; j < count; j++) {
      const d = results.docs[j]!;
      results.coverage[j] = totalIdf > 0 ? cov[d]! / totalIdf : 0;
      results.matched[j] = Math.min(hit[d]!, 255); // matched is a Uint8 count: 255 means "255 or more"
    }
    for (let i = 0; i < touchedN; i++) {
      const d = touched[i]!;
      acc[d] = 0;
      cov[d] = 0;
      hit[d] = 0;
    }
    return results;
  }

  private allocateDoc(): number {
    const reused = this.freeDocs.pop();
    if (reused !== undefined) return reused;
    const doc = this.docs++;
    if (doc >= this.alive.length) {
      const size = this.alive.length * 2;
      this.lens = growF32(this.lens, size * this.fields);
      this.alive = growU8(this.alive, size);
      this.acc = new Float32Array(size);
      this.cov = new Float32Array(size);
      this.hit = new Uint32Array(size);
      this.stamp = new Uint32Array(size);
      this.touched = new Int32Array(size);
    }
    return doc;
  }

  private ensureTerm(t: number): void {
    if (t < this.df.length) return;
    let size = this.df.length;
    while (size <= t) size *= 2;
    this.df = growU32(this.df, size);
  }

  private ensureKey(key: number): void {
    if (key >= this.postLen.length) {
      let size = this.postLen.length;
      while (size <= key) size *= 2;
      this.postLen = growU32(this.postLen, size);
    }
    if (this.postDocs[key] === undefined) {
      this.postDocs[key] = new Uint32Array(4);
      this.postTfs[key] = new Uint16Array(4);
    }
  }

  private append(key: number, doc: number, tf: number): void {
    const len = this.postLen[key]!;
    let docs = this.postDocs[key]!;
    if (len === docs.length) {
      docs = growU32(docs, len * 2);
      this.postDocs[key] = docs;
      const tfs = new Uint16Array(len * 2);
      tfs.set(this.postTfs[key]!);
      this.postTfs[key] = tfs;
    }
    docs[len] = doc;
    this.postTfs[key]![len] = tf;
    this.postLen[key] = len + 1;
  }

  /**
   * Purges dead docs' postings from the keys they used, frees the posting arrays left empty, then frees the dead docs'
   * numbers for reuse and reports each of their terms no live doc holds (`onTermFreed`).
   */
  private compact(): void {
    const F = this.fields;
    const dirty = new Set<number>();
    const terms = new Set<number>();
    for (const doc of this.pendingFree) {
      for (const t of this.docTerms[doc]!) {
        terms.add(t);
        for (let f = 0; f < F; f++) {
          const key = t * F + f;
          if (key < this.postLen.length && this.postDocs[key] !== undefined) dirty.add(key);
        }
      }
    }
    let purged = 0;
    for (const key of dirty) {
      const docs = this.postDocs[key]!;
      const tfs = this.postTfs[key]!;
      const len = this.postLen[key]!;
      let w = 0;
      for (let r = 0; r < len; r++) {
        if (this.alive[docs[r]!] === 0) continue;
        docs[w] = docs[r]!;
        tfs[w] = tfs[r]!;
        w++;
      }
      purged += len - w;
      this.postLen[key] = w;
      if (w === 0) {
        // Emptied: a term that comes back (or a new term on a released id) allocates afresh.
        this.postDocs[key] = undefined;
        this.postTfs[key] = undefined;
      } else if (w * 4 < docs.length && docs.length > 16) {
        // Mostly dead: shrink to twice what is left (appends grow by doubling), so a term whose holders came and
        // went keeps no array sized for its peak.
        this.postDocs[key] = docs.slice(0, w * 2);
        this.postTfs[key] = tfs.slice(0, w * 2);
      }
    }
    for (const doc of this.pendingFree) {
      this.docTerms[doc] = EMPTY;
      this.freeDocs.push(doc);
    }
    this.totalPostings -= purged;
    this.deadPostings = 0;
    this.pendingFree = [];
    // Last: no doc number or posting names these terms now, so the callback may release them at once.
    const freed = this.onTermFreed;
    if (freed !== undefined) for (const t of terms) if (this.df[t] === 0) freed(t);
  }
}

function has(sorted: Uint32Array, x: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === x) return true;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function growU32(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
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
