/**
 * What the ingest worker read of redacted items (`ingest.ts`, trial `ingestWorker`, D216), held beside each item until
 * the cache stores it. The cache (`ItemCache.put`) takes it once and applies it instead of reading the item again on
 * the event loop: its terms (to intern and index), its graph reading, its deflated text and its mentions.
 *
 * A chunk of items comes back from the worker as a few flat values (`PreparedChunk`): one string of the chunk's
 * distinct terms with their hash lanes, one string of its other strings (graph keys and labels, mentions), and one
 * Int32Array of per-item records. Structured clone then copies a handful of large values instead of hundreds of small
 * strings and objects an item (a reading as objects cost 34.5 µs an item to clone, about half of it on the receiving
 * thread; bench workload, scratch measurement). Each item gets a view (`Prepared`: its chunk and its place).
 *
 * Keyed by the item object in a WeakMap: an item the worker returned and nothing stores goes with its reading, and
 * `put` deletes the entry it uses. Only the redacted copy is ever a key (the worker reads nothing else, D10). A chunk is
 * one page of one user's source, so a view never reaches another user's items.
 */
import type { ContextItem } from "@eden/protocol";
import type { Extraction, NodeKind } from "./kg";

/** A chunk of items as the worker read them (see the module comment). */
export interface PreparedChunk {
  /** The worker's clock when it read them: a graph reading that binds a date is used only at the same `now`. */
  now: number;
  /** The chunk's distinct terms (folded), joined; term t is `terms.slice(termAt[t], termAt[t + 1])`. */
  terms: string;
  termAt: Uint32Array;
  /** Per term: its two hash lanes and folded length (`termHash`), so interning hashes nothing again. */
  lanes: Uint32Array;
  /** Other strings (graph keys and labels, mentions), joined; string s is `strings.slice(stringAt[s], ...)`. */
  strings: string;
  stringAt: Uint32Array;
  /** Per-item records (`RECORD`), item k's starting at `at[k]`. */
  records: Int32Array;
  at: Uint32Array;
  /** Per item: its deflated text (`packedBytes`), null when it stays plain; absent when packing was not asked. */
  packed?: ({ bytes: Uint8Array<ArrayBuffer>; latin1: boolean } | null)[];
  /** Per item: the item's long spans (`Extraction.long`), when it has any. */
  long: ({ from: string; to: string }[] | null)[];
}

/*
 * An item's record, in order: its distinct terms in order of first occurrence, title then body (the order a tokenizer
 * interns them in), as chunk term numbers (count, then each); its title's terms and its body's (count, then each); its
 * mentions or -1 (count, then strings); then its graph reading or -1: nodes (count, then key string, kind code, label
 * string and edge mask each), links (count, then strings a and b and the mask each), authors (count, then strings),
 * automated (0/1), bound (0/1).
 */

/** Node kinds by code, as the worker writes them. */
export const KIND_CODES: readonly NodeKind[] = ["name", "email", "id", "channel", "role", "day"];

/** One item's view of its chunk. */
export interface Prepared {
  chunk: PreparedChunk;
  k: number;
}

const readings = new WeakMap<ContextItem, Prepared>();
const mentioned = new WeakMap<ContextItem, string[]>();

/** Holds a redacted item's reading until the cache stores it. */
export function attachPrepared(item: ContextItem, prep: Prepared): void {
  readings.set(item, prep);
}

/** The item's reading, once: taken out, so it is applied at most once and not kept after. */
export function takePrepared(item: ContextItem): Prepared | undefined {
  const prep = readings.get(item);
  if (prep !== undefined) readings.delete(item);
  return prep;
}

/** Notes the mentions a stored copy carries (from its reading), for `takeMentions`. */
export function noteMentions(stored: ContextItem, mentions: string[]): void {
  mentioned.set(stored, mentions);
}

/** The mentions noted for a stored copy, once. */
export function takeMentions(stored: ContextItem): string[] | undefined {
  const m = mentioned.get(stored);
  if (m !== undefined) mentioned.delete(stored);
  return m;
}

/** A reader over one item's record. */
export class RecordReader {
  i: number;
  constructor(readonly p: Prepared) {
    this.i = p.chunk.at[p.k]!;
  }
  next(): number {
    return this.p.chunk.records[this.i++]!;
  }
  /** Skips a counted list of `width` words each. */
  skip(width: number): void {
    const n = this.next();
    this.i += n * width;
  }
  string(s: number): string {
    const c = this.p.chunk;
    return c.strings.slice(c.stringAt[s]!, c.stringAt[s + 1]!);
  }
}

/** A reader past an item's terms, title and body: at its mentions. */
function atMentions(p: Prepared): RecordReader {
  const r = new RecordReader(p);
  r.skip(1);
  r.skip(1);
  r.skip(1);
  return r;
}

/** The mentions a prepared item's reading holds, or null when the worker read none. */
export function preparedMentions(p: Prepared): string[] | null {
  const r = atMentions(p);
  const m = r.next();
  if (m < 0) return null;
  const out: string[] = [];
  for (let j = 0; j < m; j++) out.push(r.string(r.next()));
  return out;
}

/** The graph reading of a prepared item, rebuilt as `extract` gives it, or null when the worker read none. */
export function preparedGraph(p: Prepared): Extraction | null {
  const r = atMentions(p);
  r.skip(1);
  const n = r.next();
  if (n < 0) return null;
  const nodes = new Map<string, { kind: NodeKind; label: string; mask: number }>();
  for (let j = 0; j < n; j++) {
    const key = r.string(r.next());
    const kind = KIND_CODES[r.next()]!;
    const label = r.string(r.next());
    nodes.set(key, { kind, label, mask: r.next() });
  }
  const links: [string, string, number][] = [];
  for (let j = r.next(); j > 0; j--) {
    const a = r.string(r.next());
    const b = r.string(r.next());
    links.push([a, b, r.next()]);
  }
  const authors: string[] = [];
  for (let j = r.next(); j > 0; j--) authors.push(r.string(r.next()));
  const automated = r.next() === 1;
  const bound = r.next() === 1;
  return { nodes, links, authors, automated, bound, long: p.chunk.long[p.k] ?? [] };
}
