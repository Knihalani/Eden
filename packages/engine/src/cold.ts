/**
 * The cold tier of a user's synced copy (`syncCold`, D475, a trial): the items of one source that the user's item cap
 * (`syncMaxItems`) pushed out of the index, kept compressed in memory behind a compact index, so that a copy the cap
 * "cut" is still whole and searchable here, and its source need not be searched live (D264) on every lookup.
 *
 * Per (user, source), held on the sync's own state (it goes when the user or the source does):
 * - chunks of at most `CHUNK` items, each one zstd blob of JSON (the redacted items as the cache held them, with the
 *   time and read mark each copy was read under, so the freshness checks of D126 and D356 see the copy's real age);
 * - per chunk, the ids it holds (`IdSet`, D371) and a Bloom filter of its items' terms: a lookup opens a chunk only
 *   when the filter says one of the request's words may be in it;
 * - per pack, the signatures of the copies held (id, title, text and time hashed to 53 bits), so a listing that shows
 *   an item again can tell "unchanged" without opening anything.
 *
 * An id is in at most one chunk; an entry of a blob is live only while its chunk's id set holds its id. Nothing here
 * does I/O. Item content never leaves memory (D8).
 */
import { hashString, IdSet } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import { isStopword } from "./text";

/** Items a chunk holds at most: one blob to open for a match, small enough that opening one is well under 1 ms. */
const CHUNK = 64;
/** A pack whose blobs hold this many dead entries per live one is rewritten. */
const DEAD_RATIO = 1;
const SPLIT = /[^\p{L}\p{N}]+/u;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** A copy as the cold tier holds it: the item, when it was read and the sync's read mark its read began under. */
export interface ColdEntry {
  item: ContextItem;
  fetchedAt: number;
  readMark: number;
}

interface Chunk {
  blob: Uint8Array;
  /** Ids live in this chunk (an entry of the blob whose id is not here was superseded or deleted). */
  ids: IdSet;
  /** Entries in the blob, live or not. */
  n: number;
  bloom: Uint32Array;
}

/** The terms a cold item is matched on: lowercase words of two or more characters, stopwords out, each once. */
export function coldTerms(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(SPLIT)) {
    if (w.length < 2 || isStopword(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** A copy's signature: 53 bits of its id, title, text and time. */
export function coldSig(item: ContextItem): number {
  const s = `${item.id}\u0000${item.title}\u0000${item.text}\u0000${item.updatedAt ?? ""}`;
  const hi = hashString(s, 0x5c01d) >>> 0;
  const lo = hashString(s, 0x7e11a) >>> 0;
  return (hi & 0x1fffff) * 0x1_0000_0000 + lo;
}

function hashes(term: string): [number, number] {
  const h1 = hashString(term, 0xc01d) >>> 0;
  return [h1, (Math.imul(h1 ^ (h1 >>> 15), 0x2c1b3c6d) >>> 0) | 1];
}

function bloomOf(entries: readonly ColdEntry[]): Uint32Array {
  const terms = new Set<string>();
  for (const e of entries) for (const t of coldTerms(`${e.item.title} ${e.item.text}`)) terms.add(t);
  // 16 bits a term, two hashes: about 1.4% false matches. A power of two, at least 256 bits.
  let bits = 256;
  while (bits < terms.size * 16) bits *= 2;
  const bloom = new Uint32Array(bits / 32);
  const mask = bits - 1;
  for (const t of terms) {
    const [h1, h2] = hashes(t);
    const a = h1 & mask;
    const b = (h1 + h2) & mask;
    bloom[a >>> 5]! |= 1 << (a & 31);
    bloom[b >>> 5]! |= 1 << (b & 31);
  }
  return bloom;
}

function bloomHas(bloom: Uint32Array, h1: number, h2: number): boolean {
  const mask = bloom.length * 32 - 1;
  const a = h1 & mask;
  const b = (h1 + h2) & mask;
  return (bloom[a >>> 5]! & (1 << (a & 31))) !== 0 && (bloom[b >>> 5]! & (1 << (b & 31))) !== 0;
}

function pack(entries: readonly ColdEntry[]): Uint8Array {
  return Bun.zstdCompressSync(utf8.encode(JSON.stringify(entries)), { level: 3 });
}

function unpack(blob: Uint8Array): ColdEntry[] {
  return JSON.parse(fromUtf8.decode(Bun.zstdDecompressSync(blob))) as ColdEntry[];
}

/** A plain copy of a cached item (its `text` may be a getter over deflated bytes, D188). */
function plain(item: ContextItem): ContextItem {
  return {
    id: item.id,
    sourceId: item.sourceId,
    ref: item.ref,
    title: item.title,
    text: item.text,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    ...(item.meta !== undefined ? { meta: item.meta } : {}),
  };
}

/** A request's words as the cold tier matches them (`ColdPack.match`). */
export interface ColdQuery {
  words: readonly string[];
  hashes: readonly (readonly [number, number])[];
}

export function coldQuery(text: string): ColdQuery {
  const words = coldTerms(text);
  return { words, hashes: words.map(hashes) };
}

/** One source's cold items for one user. */
export class ColdPack {
  private chunks: Chunk[] = [];
  private sigs = new Set<number>();
  private live = 0;
  private dead = 0;

  /** Items held. */
  get size(): number {
    return this.live;
  }

  /** Bytes held: the blobs, the id sets, the filters and the signatures (8 B each, plus the set's own slots). */
  get bytes(): number {
    let n = this.sigs.size * 16;
    for (const c of this.chunks) n += c.blob.byteLength + c.ids.bytesHeld + c.bloom.byteLength;
    return n;
  }

  has(id: string): boolean {
    for (const c of this.chunks) if (c.ids.has(id)) return true;
    return false;
  }

  /** Whether the pack holds this very copy (same id, title, text and time): a listing showed it again unchanged. */
  holds(item: ContextItem): boolean {
    return this.sigs.has(coldSig(item)) && this.has(item.id);
  }

  /** Every id held (a copy). */
  ids(): string[] {
    const out: string[] = [];
    for (const c of this.chunks) for (const id of c.ids) out.push(id);
    return out;
  }

  /** Whether every id held is in `seen`. */
  allIn(seen: ReadonlySet<string>): boolean {
    for (const c of this.chunks) for (const id of c.ids) if (!seen.has(id)) return false;
    return true;
  }

  /** Adds copies (already redacted, as the cache or the fan-out gave them); one held under the same id is replaced. */
  add(entries: readonly ColdEntry[]): void {
    if (entries.length === 0) return;
    const fresh: ColdEntry[] = [];
    const seen = new Set<string>();
    // The last of two copies of one id in a batch stands.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (seen.has(e.item.id)) continue;
      seen.add(e.item.id);
      this.drop(e.item.id);
      fresh.push({ item: plain(e.item), fetchedAt: e.fetchedAt, readMark: e.readMark });
    }
    fresh.reverse();
    let at = 0;
    const last = this.chunks.at(-1);
    if (last && last.n < CHUNK) {
      // The open chunk is rewritten with what fits (its dead entries left out).
      const kept = unpack(last.blob).filter((e) => last.ids.has(e.item.id));
      this.dead -= last.n - kept.length;
      at = Math.min(fresh.length, CHUNK - kept.length);
      this.chunks[this.chunks.length - 1] = this.chunk([...kept, ...fresh.slice(0, at)]);
    }
    for (; at < fresh.length; at += CHUNK) this.chunks.push(this.chunk(fresh.slice(at, at + CHUNK)));
    for (const e of fresh) this.sigs.add(coldSig(e.item));
    this.live += fresh.length;
  }

  /** Drops an id (deleted at its source, or stored in the index again). Returns whether it was held. */
  drop(id: string): boolean {
    for (const c of this.chunks) {
      if (!c.ids.delete(id)) continue;
      this.live--;
      this.dead++;
      if (this.dead > DEAD_RATIO * Math.max(this.live, CHUNK)) this.compact();
      return true;
    }
    return false;
  }

  /**
   * The live copies that hold any of the request's words, best first (its rarer words count more, then newest), at
   * most `limit`, from at most `maxChunks` chunks (those whose filters match its rarer words). `opened` counts the
   * blobs read.
   */
  match(q: ColdQuery, limit: number, maxChunks: number, opened?: { chunks: number }): ColdEntry[] {
    if (q.words.length === 0 || this.live === 0) return [];
    // Which chunks may hold each word (their filters), and from that each word's weight: a word few chunks hold
    // says more than one they all hold, as a connector's ranked search would have it.
    const holders = q.hashes.map(() => 0);
    const may: { c: Chunk; words: number[] }[] = [];
    let chunks = 0;
    for (const c of this.chunks) {
      if (c.ids.size === 0) continue;
      chunks++;
      const words: number[] = [];
      q.hashes.forEach((h, k) => {
        if (!bloomHas(c.bloom, h[0], h[1])) return;
        words.push(k);
        holders[k]!++;
      });
      if (words.length > 0) may.push({ c, words });
    }
    if (may.length === 0) return [];
    const rare = (k: number) => Math.log(1 + chunks / holders[k]!);
    const ranked = may
      .map((m) => ({ c: m.c, score: m.words.reduce((sum, k) => sum + rare(k), 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxChunks);
    const found: { e: ColdEntry; words: number[] }[] = [];
    const df = q.words.map(() => 0);
    let read = 0;
    for (const { c } of ranked) {
      if (opened) opened.chunks++;
      for (const e of unpack(c.blob)) {
        if (!c.ids.has(e.item.id)) continue;
        read++;
        const terms = new Set(coldTerms(`${e.item.title} ${e.item.text}`));
        const words: number[] = [];
        q.words.forEach((w, k) => {
          if (!terms.has(w)) return;
          words.push(k);
          df[k]!++;
        });
        if (words.length > 0) found.push({ e, words });
      }
    }
    // Best first: the request's words an item holds, each weighted by how few of the items read hold it.
    const idf = (k: number) => Math.log(1 + (read - df[k]! + 0.5) / (df[k]! + 0.5));
    return found
      .map((x) => ({ e: x.e, score: x.words.reduce((sum, k) => sum + idf(k), 0) }))
      .sort((a, b) => b.score - a.score || (b.e.item.updatedAt ?? 0) - (a.e.item.updatedAt ?? 0))
      .slice(0, limit)
      .map((x) => x.e);
  }

  /** Every live copy (tests, and a rewrite). */
  entries(): ColdEntry[] {
    return this.chunks.flatMap((c) => unpack(c.blob).filter((e) => c.ids.has(e.item.id)));
  }

  private chunk(entries: readonly ColdEntry[]): Chunk {
    const ids = new IdSet();
    for (const e of entries) ids.add(e.item.id);
    return { blob: pack(entries), ids, n: entries.length, bloom: bloomOf(entries) };
  }

  /** Rewrites the pack from its live entries: dead entries, and the signatures of copies no longer held, go. */
  private compact(): void {
    const all = this.entries();
    this.chunks = [];
    this.sigs = new Set();
    this.dead = 0;
    this.live = 0;
    for (let at = 0; at < all.length; at += CHUNK) this.chunks.push(this.chunk(all.slice(at, at + CHUNK)));
    for (const e of all) this.sigs.add(coldSig(e.item));
    this.live = all.length;
  }
}
