/**
 * `IdSet`: an insertion-ordered set of strings held in typed arrays, for long-lived sets of ids (D371).
 *
 * A `Set<string>` of 3,000 item ids costs ~90 B an id on Bun 1.4 (a string cell and its characters, plus the set's
 * ordered table), and the strings stay alive after everything else of their user is packed away (a frozen user, D325).
 * Here an id is its characters in one byte arena (Latin-1 code units one byte each; any other code unit three:
 * `ESC` and its two bytes, so `ESC` itself is escaped), a start offset, a hash, and a slot in an open-addressed
 * table: ~30 B for a 15-character id (`bench/idset.bench.ts`).
 *
 * Same semantics as `Set<string>` for `add`, `has`, `delete`, `size`, `clear` and iteration in insertion order
 * (re-adding a present id does not move it). Deleting while iterating is allowed (the iterator skips what was
 * deleted, as `Set`'s does); an id added while iterating is visited, as with `Set`. Deleted slots are reclaimed by
 * the next `add` that needs room once they are half the slots, never while an iterator is open. Iteration makes a
 * string per id: use `has` on hot paths.
 */
import { mix32 } from "./hash";

/** Escape byte: the next two bytes are a UTF-16 code unit over 0xff (or 0xff itself). */
const ESC = 0xff;
const EMPTY = 0;
const MIN_TABLE = 16;
/** Slot capacity past which the table needs 32-bit entries (a 16-bit one holds slot + 1 below its tomb, 0xffff). */
const WIDE = 0xfffe;
const CHUNK = 4_096;

export class IdSet implements Iterable<string> {
  /** Encoded ids, back to back in insertion order. */
  private bytes = new Uint8Array(256);
  /** `bytes` as a Buffer, for its native Latin-1 decode (`latin1Slice`). */
  private view = Buffer.from(this.bytes.buffer);
  private used = 0;
  /** Per slot (insertion order): start in `bytes` (the end is the next slot's start), hash, live (1) or deleted (0). */
  private starts = new Uint32Array(17);
  private hashes = new Uint32Array(16);
  private live = new Uint8Array(16);
  private slots = 0;
  /**
   * Open-addressed table: slot + 1, `EMPTY`, or `tomb`. Power-of-two size, at most three quarters full (live and
   * tombs), linear probing; 16-bit entries until the slots outgrow them (`WIDE`).
   */
  private table: Uint16Array | Uint32Array = new Uint16Array(MIN_TABLE);
  private tomb = 0xffff;
  private filled = 0;
  private count = 0;
  /** Scratch for the id being looked up, encoded once. */
  private static key = new Uint8Array(256);
  private static keyLen = 0;

  get size(): number {
    return this.count;
  }

  has(id: string): boolean {
    return this.find(IdSet.encode(id)) >= 0;
  }

  /** Adds `id` at the end unless present (a present id keeps its place, as with `Set`). */
  add(id: string): this {
    const h = IdSet.encode(id);
    if (this.find(h) >= 0) return this;
    const n = IdSet.keyLen;
    // Grow (and drop deleted slots, when they are many) before writing.
    if (this.slots === this.hashes.length || this.used + n > this.bytes.length) this.grow(n);
    this.bytes.set(IdSet.key.subarray(0, n), this.used);
    this.used += n;
    const slot = this.slots++;
    this.starts[slot + 1] = this.used;
    this.hashes[slot] = h;
    this.live[slot] = 1;
    this.count++;
    // A rehash places every live slot, this one included.
    if ((this.filled + 1) * 4 > this.table.length * 3) this.rehash(this.table.length * 2);
    else this.place(slot, h);
    return this;
  }

  delete(id: string): boolean {
    const at = this.find(IdSet.encode(id));
    if (at < 0) return false;
    const slot = this.table[at]! - 1;
    this.table[at] = this.tomb;
    this.live[slot] = 0;
    this.count--;
    return true;
  }

  clear(): void {
    this.bytes = new Uint8Array(256);
    this.view = Buffer.from(this.bytes.buffer);
    this.used = 0;
    this.starts = new Uint32Array(17);
    this.hashes = new Uint32Array(16);
    this.live = new Uint8Array(16);
    this.slots = 0;
    this.table = new Uint16Array(MIN_TABLE);
    this.tomb = 0xffff;
    this.filled = 0;
    this.count = 0;
  }

  *[Symbol.iterator](): IterableIterator<string> {
    // Fields are re-read each step: an `add` may grow the arrays mid-iteration. It never compacts while an iterator
    // is open (`open`), so slot numbers stay put; a `for…of` that breaks out closes it (`finally`).
    this.open++;
    try {
      for (let i = 0; i < this.slots; i++) if (this.live[i] === 1) yield this.decode(i);
    } finally {
      this.open--;
    }
  }

  keys(): IterableIterator<string> {
    return this[Symbol.iterator]();
  }

  values(): IterableIterator<string> {
    return this[Symbol.iterator]();
  }

  /** Bytes held by the arrays (what a heap snapshot would attribute to this set). */
  get bytesHeld(): number {
    return (
      this.bytes.byteLength +
      this.starts.byteLength +
      this.hashes.byteLength +
      this.live.byteLength +
      this.table.byteLength
    );
  }

  // --- internals --------------------------------------------------------------------------------------------------

  /** Iterators not yet finished: compaction waits for none (an abandoned iterator only stops compaction). */
  private open = 0;

  /** Encodes `id` into the shared scratch and returns its hash. */
  private static encode(id: string): number {
    const len = id.length;
    let key = IdSet.key;
    if (len * 3 > key.length) key = IdSet.key = new Uint8Array(len * 3 * 2);
    let n = 0;
    let h = 0x811c9dc5;
    for (let i = 0; i < len; i++) {
      const c = id.charCodeAt(i);
      if (c < ESC) {
        key[n++] = c;
        h = Math.imul(h ^ c, 0x01000193);
      } else {
        key[n++] = ESC;
        key[n++] = c >>> 8;
        key[n++] = c & 0xff;
        h = Math.imul(h ^ ESC, 0x01000193);
        h = Math.imul(h ^ (c >>> 8), 0x01000193);
        h = Math.imul(h ^ (c & 0xff), 0x01000193);
      }
    }
    IdSet.keyLen = n;
    return mix32(h) >>> 0;
  }

  /** The table position holding `id` (encoded in the scratch, hash `h`), or -1. */
  private find(h: number): number {
    const mask = this.table.length - 1;
    const key = IdSet.key;
    const n = IdSet.keyLen;
    for (let p = h & mask; ; p = (p + 1) & mask) {
      const v = this.table[p]!;
      if (v === EMPTY) return -1;
      if (v === this.tomb) continue;
      const slot = v - 1;
      if (this.hashes[slot] !== h) continue;
      const a = this.starts[slot]!;
      if (this.starts[slot + 1]! - a !== n) continue;
      let same = true;
      for (let i = 0; i < n; i++) {
        if (this.bytes[a + i] !== key[i]) {
          same = false;
          break;
        }
      }
      if (same) return p;
    }
  }

  private place(slot: number, h: number): void {
    const mask = this.table.length - 1;
    let p = h & mask;
    while (this.table[p] !== EMPTY) p = (p + 1) & mask;
    this.table[p] = slot + 1;
    this.filled++;
  }

  private rehash(size: number): void {
    const wide = this.hashes.length >= WIDE;
    this.table = wide ? new Uint32Array(Math.max(MIN_TABLE, size)) : new Uint16Array(Math.max(MIN_TABLE, size));
    this.tomb = wide ? 0xffffffff : 0xffff;
    this.filled = 0;
    for (let s = 0; s < this.slots; s++) if (this.live[s] === 1) this.place(s, this.hashes[s]!);
  }

  /** Room for one more slot of `n` bytes: compacts when at least half the slots are deleted, else doubles. */
  private grow(n: number): void {
    if (this.open === 0 && this.count * 2 <= this.slots) {
      this.compact();
      if (this.slots < this.hashes.length && this.used + n <= this.bytes.length) return;
    }
    if (this.slots === this.hashes.length) {
      const cap = this.hashes.length * 2;
      const starts = new Uint32Array(cap + 1);
      starts.set(this.starts.subarray(0, this.slots + 1));
      this.starts = starts;
      const hashes = new Uint32Array(cap);
      hashes.set(this.hashes.subarray(0, this.slots));
      this.hashes = hashes;
      const live = new Uint8Array(cap);
      live.set(this.live.subarray(0, this.slots));
      this.live = live;
      if (cap >= WIDE && this.tomb === 0xffff) this.rehash(this.table.length);
    }
    if (this.used + n > this.bytes.length) {
      const bytes = new Uint8Array(Math.max(this.bytes.length * 2, this.used + n));
      bytes.set(this.bytes.subarray(0, this.used));
      this.bytes = bytes;
      this.view = Buffer.from(bytes.buffer);
    }
  }

  /** Drops deleted slots and their bytes in place, keeping order; rebuilds the table. */
  private compact(): void {
    let w = 0;
    let at = 0;
    for (let s = 0; s < this.slots; s++) {
      if (this.live[s] === 0) continue;
      const a = this.starts[s]!;
      const b = this.starts[s + 1]!;
      if (a !== at) this.bytes.copyWithin(at, a, b);
      this.starts[w] = at;
      at += b - a;
      this.hashes[w] = this.hashes[s]!;
      this.live[w] = 1;
      w++;
    }
    this.starts[w] = at;
    this.live.fill(0, w, this.slots);
    this.slots = w;
    this.used = at;
    // Shrink the table back when the set has shrunk a lot (a source whose items were dropped).
    let size = MIN_TABLE;
    while (size * 3 < (w + 1) * 4) size *= 2;
    this.rehash(size);
  }

  private decode(slot: number): string {
    const a = this.starts[slot]!;
    const b = this.starts[slot + 1]!;
    const bytes = this.bytes;
    let plain = true;
    for (let i = a; i < b && plain; i++) if (bytes[i] === ESC) plain = false;
    if (plain) return this.view.toString("latin1", a, b);
    const units: number[] = [];
    for (let i = a; i < b; i++) {
      const c = bytes[i]!;
      if (c === ESC) {
        units.push((bytes[i + 1]! << 8) | bytes[i + 2]!);
        i += 2;
      } else units.push(c);
    }
    let out = "";
    for (let i = 0; i < units.length; i += CHUNK) out += String.fromCharCode.apply(null, units.slice(i, i + CHUNK));
    return out;
  }
}
