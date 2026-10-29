/**
 * An in-memory inverted index with BM25 scoring over term ids (from `Vocab`/`tokenizeInto`), for one user's cache.
 *
 * Layout: per (term, field), postings in two growable typed arrays (doc numbers, term frequencies); per doc, its field
 * lengths, a live flag and its sorted unique term ids (kept for removal, and so callers can test "does this doc contain
 * all of these terms" by binary search instead of re-tokenizing the text). Scoring is term-at-a-time into a reused
 * dense Float32Array accumulator plus a touched-docs list, then top-k: no per-query allocation beyond the result.
 *
 * Removal marks the doc dead (skipped when scoring) and updates df and lengths at once; postings of dead docs are
 * purged in one compaction pass when they reach ~10% of all postings, after which their doc numbers are reused.
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
}

export interface SearchResults {
  count: number;
  docs: Int32Array;
  scores: Float64Array;
  coverage: Float32Array;
  matched: Uint8Array;
}

const EMPTY = new Uint32Array(0);

export class SparseIndex {
  private readonly k1: number;
  private readonly fields: number;
  private readonly b: Float64Array;
  private readonly weights: Float64Array;
  private readonly delta: number;
  // Per term key (term × fields + field): postings.
  private postDocs: Uint32Array[] = [];
  private postTfs: Uint16Array[] = [];
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
  // Per term: the query that last held it, so a repeated query term is skipped in O(1).
  private queryTermStamp: Uint32Array = new Uint32Array(64);
  // Insert scratch, indexed by term id: per-field counts tagged with a stamp (no clearing, no hashing), the doc-level
  // seen stamp, and the touched-term lists. Replaced a Map and a Set per insert (bench/index.bench.ts).
  private tfCount = new Uint32Array(1_024);
  private tfStamp = new Uint32Array(1_024);
  private docStamp = new Uint32Array(1_024);
  private stampNo = 0;
  private fieldTouched = new Uint32Array(1_024);
  private docTouched = new Uint32Array(1_024);

  constructor(options: SparseIndexOptions = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.fields = Math.max(1, options.fields ?? 1);
    this.b = Float64Array.from({ length: this.fields }, (_, f) => options.b?.[f] ?? 0.75);
    this.weights = Float64Array.from({ length: this.fields }, (_, f) => options.weights?.[f] ?? 1);
    this.delta = options.delta ?? 0;
    this.totalLens = new Float64Array(this.fields);
    this.lens = new Float32Array(64 * this.fields);
  }

  /** Live documents. */
  get size(): number {
    return this.live;
  }

  /** Adds a one-field doc from its term ids in order (repeats are its term frequencies). Returns its doc number. */
  add(terms: Uint32Array, n: number): number {
    return this.addFields([terms], [n]);
  }

  /** Adds a doc with one term-id array per field (`fieldTerms[f][0..counts[f])`). Returns its doc number. */
  addFields(fieldTerms: Uint32Array[], counts: number[]): number {
    const F = this.fields;
    const doc = this.allocateDoc();
    if (this.stampNo > 0xffff_fff0) {
      // Stamps are Uint32: before the counter wraps, clear them so an old stamp can never equal a new one.
      this.tfStamp.fill(0);
      this.docStamp.fill(0);
      this.stampNo = 0;
    }
    const docMark = ++this.stampNo;
    let docUnique = 0;
    for (let f = 0; f < F; f++) {
      const terms = fieldTerms[f];
      const n = terms === undefined ? 0 : (counts[f] ?? 0);
      const fieldMark = ++this.stampNo;
      let fieldUnique = 0;
      for (let i = 0; i < n; i++) {
        const t = terms![i]!;
        if (t >= this.tfCount.length) this.growScratch(t);
        if (this.tfStamp[t] !== fieldMark) {
          this.tfStamp[t] = fieldMark;
          this.tfCount[t] = 0;
          this.fieldTouched[fieldUnique++] = t;
        }
        this.tfCount[t]!++;
        if (this.docStamp[t] !== docMark) {
          this.docStamp[t] = docMark;
          this.docTouched[docUnique++] = t;
        }
      }
      for (let j = 0; j < fieldUnique; j++) {
        const t = this.fieldTouched[j]!;
        const c = this.tfCount[t]!;
        const key = t * F + f;
        this.ensureKey(key);
        this.append(key, doc, c > 65_535 ? 65_535 : c);
      }
      this.lens[doc * F + f] = n;
      this.totalLens[f]! += n;
      this.totalPostings += fieldUnique;
    }
    const unique = this.docTouched.slice(0, docUnique);
    unique.sort();
    for (let i = 0; i < docUnique; i++) {
      const t = unique[i]!;
      this.ensureTerm(t);
      this.df[t]!++;
    }
    this.docTerms[doc] = unique;
    this.alive[doc] = 1;
    this.live++;
    return doc;
  }

  /** Grows the insert scratch so term id `t` fits; lists are sized like the arrays (a field has ≤ that many terms). */
  private growScratch(t: number): void {
    let size = this.tfCount.length;
    while (size <= t) size *= 2;
    const grow = (a: Uint32Array) => {
      const b = new Uint32Array(size);
      b.set(a);
      return b;
    };
    this.tfCount = grow(this.tfCount);
    this.tfStamp = grow(this.tfStamp);
    this.docStamp = grow(this.docStamp);
    this.fieldTouched = grow(this.fieldTouched); // may grow mid-field: keep what this field touched so far
    this.docTouched = grow(this.docTouched);
  }

  remove(doc: number): void {
    if (doc < 0 || doc >= this.docs || this.alive[doc] === 0) return;
    this.alive[doc] = 0;
    const terms = this.docTerms[doc]!;
    const F = this.fields;
    for (let i = 0; i < terms.length; i++) this.df[terms[i]!]!--;
    for (let f = 0; f < F; f++) this.totalLens[f]! -= this.lens[doc * F + f]!;
    this.live--;
    this.deadPostings += terms.length; // at least this many postings died (a term may sit in several fields)
    this.pendingFree.push(doc);
    if (this.deadPostings > 64 && this.deadPostings * 10 > this.totalPostings) this.compact();
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
      this.queryTermStamp.fill(0);
      this.queryNo = 0;
    }
    if (this.queryTermStamp.length < this.df.length) this.queryTermStamp = growU32(this.queryTermStamp, this.df.length);
    const queryMark = ++this.queryNo;
    const termStamp = this.queryTermStamp;
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

  /** Purges dead docs' postings from the keys they used, then frees their doc numbers for reuse. */
  private compact(): void {
    const F = this.fields;
    const dirty = new Set<number>();
    for (const doc of this.pendingFree) {
      for (const t of this.docTerms[doc]!) {
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
    }
    for (const doc of this.pendingFree) {
      this.docTerms[doc] = EMPTY;
      this.freeDocs.push(doc);
    }
    this.totalPostings -= purged;
    this.deadPostings = 0;
    this.pendingFree = [];
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
