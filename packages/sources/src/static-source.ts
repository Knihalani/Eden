import { itemId, type ContextItem } from "@eden/protocol";
import { dayFactsClass, dayFactsOf, type DayFacts } from "@eden/primitives/day-facts";
import { dayKeys } from "@eden/primitives/days";
import type { SearchQuery, Source } from "./source";

export interface StaticDoc {
  ref: string;
  title: string;
  text: string;
  url?: string;
  updatedAt?: number;
  /** Source-reported fields kept with the item (a mailbox category, a label). */
  meta?: Record<string, string>;
}

/**
 * The term definition of this source. Not `@eden/primitives`' tokenizer: that folds accents ("Zoë" and "zoe" are one
 * term) and would change what matches; search results must stay as they were (D175). A joiner keeps what it joins
 * ("v2.1", "ops-142", "a_b.c") but never ends a term: "booking." at a sentence's end is "booking", or a doc whose
 * only copy of the word ended a sentence could never be found (D2059).
 */
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}]*(?:[._-]+[\p{L}\p{N}]+)*/gu) ?? [];

/**
 * The postings of every term: the documents that contain it, ascending, once each (CSR layout). Built on the first
 * search, not in the constructor: the server builds one StaticSource per user scope (`user-sources.ts`), most of
 * which may never search (D175).
 */
interface TermIndex {
  /** Term → row in `starts`. */
  ids: Map<string, number>;
  /** Row t's postings are `docs[starts[t], starts[t + 1])`. */
  starts: Uint32Array;
  docs: Uint32Array;
  /** Documents with a start day (`meta.start`), and that day. */
  datedDocs: Uint32Array;
  days: string[];
  /** Per-document day facts (`dayFactsOf`): a window also lists what covers, names or recurs on its days. */
  facts: (DayFacts | undefined)[];
  /** Per-search scratch, one slot per document; zero between searches (search has no await). */
  hits: Uint32Array;
  dated: Uint8Array;
}

/**
 * A fixed set of documents with plain term-overlap search. For tests, evals, and a tenant's own reference docs
 * (policies, FAQs) that do not need a live connector.
 */
export class StaticSource implements Source {
  readonly kind = "static";
  private readonly items: ContextItem[];
  private index: TermIndex | undefined;
  private byRef: Map<string, ContextItem> | undefined;

  constructor(
    readonly id: string,
    readonly description: string,
    docs: StaticDoc[],
  ) {
    this.items = docs.map((d) => ({ ...d, id: itemId(id, d.ref), sourceId: id }));
  }

  /**
   * Lists by time when any of its items sits on a day: a `meta.start`, or a day only its text knows (a span,
   * a date or weekday it writes, a weekday it recurs on — `dayFactsOf`, D1978).
   */
  get listsByTime(): boolean {
    return this.items.some((i) => i.meta?.start !== undefined || dayFactsOf(i.title, i.text) !== 0);
  }

  /**
   * Documents ranked by how many distinct query terms they contain; with a window, what starts in it comes first,
   * matched words or not (a calendar listed by time). Ties keep document order. Cost is the query terms' postings
   * plus the dated documents, not the whole corpus.
   */
  async search(query: SearchQuery): Promise<ContextItem[]> {
    const terms = new Set([...words(query.text), ...query.entities.flatMap(words)]);
    const w = query.window;
    if (terms.size === 0 && !w) return [];
    const ix = (this.index ??= this.build());
    const { hits, dated } = ix;
    const found: number[] = [];
    for (const t of terms) {
      const row = ix.ids.get(t);
      if (row === undefined) continue;
      for (let p = ix.starts[row]!, end = ix.starts[row + 1]!; p < end; p++) {
        const d = ix.docs[p]!;
        const h = hits[d]!;
        hits[d] = h + 1;
        if (h === 0) found.push(d);
      }
    }
    if (w) {
      for (let k = 0; k < ix.datedDocs.length; k++) {
        const day = ix.days[k]!;
        if (day < w.start || day >= w.end) continue;
        const d = ix.datedDocs[k]!;
        dated[d] = 1;
        if (hits[d] === 0) found.push(d);
      }
      // A document whose day lives only in its text ("Thursday 16:15", "every weekday 9:30", "out 30 Oct – 6 Nov")
      // lists on the days it covers or names, the same facts `ItemCache.dated` reads (D1978). One with a
      // `meta.start` is a dated instance: it lists by that start, not again on every day it says it recurs on.
      const days = new Set<string>();
      for (let t = Date.parse(`${w.start}T00:00:00Z`); !Number.isNaN(t); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (day >= w.end) break;
        days.add(day);
      }
      const want = dayKeys(days);
      for (let d = 0; d < ix.facts.length; d++) {
        const f = ix.facts[d];
        if (f === undefined || this.items[d]!.meta?.start !== undefined || dated[d] === 1) continue;
        if (dayFactsClass(f, days, want, this.items[d]!.updatedAt) > 0) {
          dated[d] = 1;
          if (hits[d] === 0) found.push(d);
        }
      }
    }
    // Dated first, then more hits, then document order: what the stable sort over all documents gave.
    found.sort((a, b) => dated[b]! - dated[a]! || hits[b]! - hits[a]! || a - b);
    const out = found.slice(0, query.limit).map((d) => this.items[d]!);
    for (const d of found) {
      hits[d] = 0;
      dated[d] = 0;
    }
    return out;
  }

  /** It holds its documents: a ref it does not have is not there. */
  readonly fetchReportsGone = true;

  async fetch(ref: string): Promise<ContextItem | null> {
    if (!this.byRef) {
      this.byRef = new Map();
      // The first document with a ref wins, as `find` did.
      for (const i of this.items) if (!this.byRef.has(i.ref)) this.byRef.set(i.ref, i);
    }
    return this.byRef.get(ref) ?? null;
  }

  private build(): TermIndex {
    const n = this.items.length;
    const ids = new Map<string, number>();
    const counts: number[] = [];
    // The last document each term was counted for: a term repeated in one document is one posting.
    const last: number[] = [];
    // Each document's distinct term rows, in document order: document d's are `rows[ends[d - 1], ends[d])`.
    const rows: number[] = [];
    const ends = new Uint32Array(n);
    for (let d = 0; d < n; d++) {
      const item = this.items[d]!;
      for (const t of words(`${item.title} ${item.text}`)) {
        let row = ids.get(t);
        if (row === undefined) {
          row = counts.length;
          ids.set(t, row);
          counts.push(0);
          last.push(-1);
        }
        if (last[row] === d) continue;
        last[row] = d;
        counts[row]!++;
        rows.push(row);
      }
      ends[d] = rows.length;
    }
    const starts = new Uint32Array(counts.length + 1);
    for (let t = 0; t < counts.length; t++) starts[t + 1] = starts[t]! + counts[t]!;
    const fill = starts.slice(0, counts.length);
    const docs = new Uint32Array(rows.length);
    for (let d = 0, p = 0; d < n; d++) for (; p < ends[d]!; p++) docs[fill[rows[p]!]!++] = d;
    const dated: number[] = [];
    const days: string[] = [];
    const facts: (DayFacts | undefined)[] = [];
    for (let d = 0; d < n; d++) {
      const day = this.items[d]!.meta?.start?.slice(0, 10);
      if (day) {
        dated.push(d);
        days.push(day);
      }
      const f = dayFactsOf(this.items[d]!.title, this.items[d]!.text);
      facts.push(f === 0 ? undefined : f);
    }
    return {
      ids,
      starts,
      docs,
      datedDocs: Uint32Array.from(dated),
      days,
      facts,
      hits: new Uint32Array(n),
      dated: new Uint8Array(n),
    };
  }
}
