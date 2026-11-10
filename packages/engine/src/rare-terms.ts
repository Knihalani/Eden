/**
 * `sourceYieldEarn` (D600): which few of a user's sources hold a word. One table a user, sized by the distinct words
 * their sources listed, in place of a wider sketch per source: a per-source sketch that keeps false holders rare
 * across a thousand sources costs two to four times the default's bytes (docs/research/o1-earn.md §2b), and what
 * the rule asks is narrower than "does this source hold the word": only "is this word held by at most two sources,
 * and which".
 *
 * A word is kept as a 20-bit tag in a slot chosen by other bits of its hash, with the small integer of one source
 * that holds it; a word a second source holds takes a second slot, a third marks it common, and a common word keeps
 * one slot and no source. So a word costs 4 bytes whatever the number of sources that hold it. The table grows a
 * segment at a time (1 KB, doubling to 16 KB each) up to `MAX_SEGMENTS` (1 MB); past that a word with no free slot
 * in reach is not added (`dropped` counts them), and if another source holds it the word is marked common: a full
 * table fails towards weak evidence, never towards a live read. No slot is ever freed: a source that no longer
 * lists a word still holds it here (as in its sketch); a source the user dropped has its number retired
 * (`forgetSource`), so its words name no one.
 *
 * Content-free as the sketches are (hashed bits, never a word), per user, in memory; saved with the user's sync
 * state only under D425's opt-in.
 */

/** Slots of the first segment (a power of two): 1 KB. Each after it is twice the last, up to `SEGMENT_SLOTS`. */
const FIRST_SLOTS = 1 << 8;
/** Slots of a full-size segment: 16 KB, so a table holds at most that much more than its words need. */
const SEGMENT_SLOTS = 1 << 12;
/** Segments a user: four growing ones and 63 of full size, about 262,000 word slots, 1 MB in all. */
export const MAX_SEGMENTS = 67;
const slotsOf = (segment: number) => Math.min(FIRST_SLOTS << Math.min(segment, 8), SEGMENT_SLOTS);
/** Slots looked at from a word's first slot in a segment. */
const REACH = 24;
/** Sources a user's table can name (12 bits; one value is kept for "common"). */
const MAX_SOURCES = (1 << 12) - 1;
const COMMON = MAX_SOURCES;

export class RareTerms {
  private readonly segments: Uint32Array[] = [];
  private used = 0;
  /** A source's number is its place here; a source the user dropped leaves a hole (`forgetSource`). */
  private readonly ids: (string | undefined)[] = [];
  private readonly numbers = new Map<string, number>();
  /** Words not added because the table was full or the user has too many sources. */
  dropped = 0;

  /** Bytes held by the table (the sources' ids apart). */
  get bytes(): number {
    let n = 0;
    for (const seg of this.segments) n += seg.byteLength;
    return n;
  }

  /** Word slots in use. */
  get size(): number {
    return this.used;
  }

  /** The source holds the word (by `termHashes`' two hashes). */
  add(sourceId: string, h1: number, h2: number): void {
    let n = this.numbers.get(sourceId);
    if (n === undefined && this.ids.length < MAX_SOURCES) {
      n = this.ids.length;
      this.ids.push(sourceId);
      this.numbers.set(sourceId, n);
    }
    // Out of source numbers: the word cannot be kept under this source, but it is still looked up, so a word
    // another source holds is marked common below instead of staying "held by one" (the review).
    const numbered = n !== undefined;
    const tag = h2 >>> 12 || 1;
    let holders = 0;
    let first = -1;
    let firstIn: Uint32Array | undefined;
    for (const seg of this.segments) {
      const mask = seg.length - 1;
      for (let k = 0; k < REACH; k++) {
        const i = (h1 + k) & mask;
        const slot = seg[i]!;
        if (slot === 0) break;
        if (slot >>> 12 !== tag) continue;
        const who = slot & 0xfff;
        if (who === COMMON || who === n) return;
        if (holders === 0) {
          first = i;
          firstIn = seg;
        }
        holders++;
      }
    }
    if (holders >= 2) {
      // A third source: the word is common. One slot says so; the other is left as it is (it reads as common too,
      // since the word's slots are read together).
      firstIn![first] = ((tag << 12) | COMMON) >>> 0;
      return;
    }
    if (numbered && this.put(h1, ((tag << 12) | n!) >>> 0)) return;
    // Not kept (no number for the source, or no free slot in reach of a full table). The table must not then say
    // fewer sources hold the word than do: with one holder kept, the word is marked common. It fails towards weak
    // evidence, never towards a live read.
    this.dropped++;
    if (holders >= 1) firstIn![first] = ((tag << 12) | COMMON) >>> 0;
  }

  /**
   * The user no longer has the source: its number is retired, so its words name no one (their slots stay, and
   * still count towards "common"), and a source that comes back under the same id starts with nothing.
   */
  forgetSource(sourceId: string): void {
    const n = this.numbers.get(sourceId);
    if (n === undefined) return;
    this.numbers.delete(sourceId);
    this.ids[n] = undefined;
  }

  private put(h1: number, value: number): boolean {
    for (;;) {
      // Any segment with a free slot in the word's reach: an older one fills up before a new one is added.
      for (const seg of this.segments) {
        const mask = seg.length - 1;
        for (let k = 0; k < REACH; k++) {
          const i = (h1 + k) & mask;
          if (seg[i] !== 0) continue;
          seg[i] = value;
          this.used++;
          return true;
        }
      }
      if (this.segments.length >= MAX_SEGMENTS) break;
      this.segments.push(new Uint32Array(slotsOf(this.segments.length)));
    }
    return false;
  }

  /**
   * The sources that hold the word, when at most `max` (1 or 2) do; else none (no source holds it, more do, or it
   * was never added).
   */
  holders(h1: number, h2: number, max: number): string[] {
    const tag = h2 >>> 12 || 1;
    const out: string[] = [];
    for (const seg of this.segments) {
      const mask = seg.length - 1;
      for (let k = 0; k < REACH; k++) {
        const slot = seg[(h1 + k) & mask]!;
        if (slot === 0) break;
        if (slot >>> 12 !== tag) continue;
        const who = slot & 0xfff;
        if (who === COMMON) return [];
        const id = this.ids[who];
        if (id !== undefined && !out.includes(id)) out.push(id);
      }
    }
    return out.length <= max ? out : [];
  }

  /** The table as JSON can hold it (D425: saved, encrypted, with a persisted user's sync state). */
  dump(): { ids: (string | null)[]; segments: string[] } {
    return {
      ids: this.ids.map((id) => id ?? null),
      segments: this.segments.map((s) => Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString("base64")),
    };
  }

  /** A table from `dump`'s output, or null when it is not one. */
  static load(d: unknown): RareTerms | null {
    const x = d as { ids?: unknown; segments?: unknown } | null;
    if (!Array.isArray(x?.ids) || !Array.isArray(x.segments)) return null;
    if (x.ids.length > MAX_SOURCES || x.segments.length > MAX_SEGMENTS) return null;
    if (!x.ids.every((i) => i === null || typeof i === "string")) return null;
    if (!x.segments.every((s) => typeof s === "string")) return null;
    const t = new RareTerms();
    for (const id of x.ids as (string | null)[]) {
      if (id !== null) t.numbers.set(id, t.ids.length);
      t.ids.push(id ?? undefined);
    }
    for (const s of x.segments as string[]) {
      const bytes = Buffer.from(s, "base64");
      const slots = slotsOf(t.segments.length);
      if (bytes.byteLength !== slots * 4) return null;
      const seg = new Uint32Array(slots);
      new Uint8Array(seg.buffer).set(bytes);
      t.segments.push(seg);
      let used = 0;
      for (const v of seg) if (v !== 0) used++;
      t.used += used;
    }
    return t;
  }
}
