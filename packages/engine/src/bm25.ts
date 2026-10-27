import { contentTerms } from "./text";

interface Doc {
  terms: Map<string, number>;
  length: number;
}

export interface Hit {
  id: string;
  score: number;
  /**
   * The share of the query the document covers, weighted by idf, over the query terms the index knows: 0..1, and
   * comparable across queries where raw BM25 is not. Ranking uses `score`; confidence uses `coverage`.
   */
  coverage: number;
}

/** A small in-memory BM25 index. One per user; sized for a cache of a few thousand items. */
export class Bm25Index {
  private readonly docs = new Map<string, Doc>();
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  add(id: string, text: string): void {
    this.remove(id);
    const terms = new Map<string, number>();
    const list = contentTerms(text);
    for (const t of list) terms.set(t, (terms.get(t) ?? 0) + 1);
    for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.set(id, { terms, length: list.length });
    this.totalLength += list.length;
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const t of doc.terms.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
  }

  private idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.size - n + 0.5) / (n + 0.5));
  }

  search(query: string, limit: number): Hit[] {
    const terms = [...new Set(contentTerms(query))];
    if (terms.length === 0 || this.docs.size === 0) return [];
    const avg = this.totalLength / this.docs.size || 1;
    // Terms no document holds say nothing about any document; counting them would punish a long, chatty query.
    const known = terms.filter((t) => this.df.has(t));
    if (known.length === 0) return [];
    const totalIdf = known.reduce((sum, t) => sum + this.idf(t), 0) || 1;
    const hits: Hit[] = [];
    for (const [id, doc] of this.docs) {
      let score = 0;
      let covered = 0;
      for (const t of known) {
        const f = doc.terms.get(t);
        if (!f) continue;
        const idf = this.idf(t);
        covered += idf;
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / avg));
      }
      if (score > 0) hits.push({ id, score, coverage: covered / totalIdf });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
