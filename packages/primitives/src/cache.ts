/**
 * A bounded cache with S3-FIFO eviction (Yang et al., SOSP 2023), a byte budget and two TTLs.
 *
 * Eviction. New keys enter a small FIFO (10% of the budget). A key read again while there moves to the main FIFO
 * when it reaches the head; a key never read again leaves after one pass and is remembered only in a ghost list of
 * keys, so if it returns soon it goes straight to main. Main is FIFO with lazy promotion: an entry read since it last
 * reached the head is reinserted (its 2-bit frequency decremented) instead of evicted. One-hit wonders (most lookup
 * results) are filtered quickly and reads only bump a counter. On skewed traces the hit ratio beats LRU by 15–35%
 * relative (bench/cache.bench.ts; numbers in docs/research/primitives.md).
 *
 * Layout. Entries live in parallel typed arrays indexed by slot (struct of arrays), FIFOs are Int32Array rings of
 * slots, freed slots go on a free list: a steady-state get/set allocates nothing, so there are no GC pauses in p99.
 * A deleted entry is only marked dead; its slot is freed when it reaches its FIFO's head, so a slot is never in two
 * ring positions at once and each ring needs no more room than there are slots.
 *
 * Budget. Each entry has a cost in bytes (the caller's estimate, default 1, making the budget an entry count).
 *
 * TTLs. `staleAfterMs`: past it `get` still returns the value and `isStale` is true, for stale-while-revalidate.
 * `expireAfterMs`: past it the entry is gone. Both are per entry, defaulted per cache. The clock is read only for
 * entries that have a TTL.
 */
export interface CacheOptions {
  maxBytes: number;
  staleAfterMs?: number;
  expireAfterMs?: number;
  now?: () => number;
}

const LIVE = 1;
const IN_MAIN = 2;

/** A ring buffer of slot numbers. */
class Ring {
  buf: Int32Array;
  head = 0;
  length = 0;
  constructor(capacity: number) {
    this.buf = new Int32Array(capacity);
  }
  push(slot: number): void {
    if (this.length === this.buf.length) this.grow();
    this.buf[(this.head + this.length) % this.buf.length] = slot;
    this.length++;
  }
  shift(): number {
    if (this.length === 0) return -1;
    const slot = this.buf[this.head]!;
    this.head = (this.head + 1) % this.buf.length;
    this.length--;
    return slot;
  }
  private grow(): void {
    const next = new Int32Array(this.buf.length * 2);
    for (let i = 0; i < this.length; i++) next[i] = this.buf[(this.head + i) % this.buf.length]!;
    this.buf = next;
    this.head = 0;
  }
}

export class S3FifoCache<K, V> {
  private readonly index = new Map<K, number>();
  private keys: (K | undefined)[] = [];
  private values: (V | undefined)[] = [];
  private bytesOf: Int32Array;
  private freq: Uint8Array;
  private flags: Uint8Array;
  private staleAt: Float64Array;
  private expiresAt: Float64Array;
  private free: number[] = [];
  private slots = 0;
  private readonly small: Ring;
  private readonly main: Ring;
  /** Ghost keys → the sequence number of their newest ring entry; older ring entries for a key are ignored. */
  private readonly ghost = new Map<K, number>();
  private ghostKeys: (K | undefined)[];
  private ghostSeqs: Float64Array;
  private ghostSeq = 0;
  private ghostHead = 0;
  private ghostLength = 0;
  private smallBytes = 0;
  private mainBytes = 0;
  private readonly maxBytes: number;
  private readonly smallTarget: number;
  private readonly staleAfterMs: number;
  private readonly expireAfterMs: number;
  private readonly now: () => number;

  constructor(options: CacheOptions) {
    this.maxBytes = Math.max(1, options.maxBytes);
    this.smallTarget = Math.max(1, Math.floor(this.maxBytes / 10));
    this.expireAfterMs = options.expireAfterMs ?? Infinity;
    this.staleAfterMs = Math.min(options.staleAfterMs ?? Infinity, this.expireAfterMs);
    this.now = options.now ?? Date.now;
    const initial = 64;
    this.bytesOf = new Int32Array(initial);
    this.freq = new Uint8Array(initial);
    this.flags = new Uint8Array(initial);
    this.staleAt = new Float64Array(initial);
    this.expiresAt = new Float64Array(initial);
    this.small = new Ring(initial);
    this.main = new Ring(initial);
    this.ghostKeys = new Array(initial);
    this.ghostSeqs = new Float64Array(initial);
  }

  get size(): number {
    return this.index.size;
  }

  get bytes(): number {
    return this.smallBytes + this.mainBytes;
  }

  /** The value (fresh or stale), or undefined if absent or expired. Counts as a read. */
  get(key: K): V | undefined {
    const slot = this.index.get(key);
    if (slot === undefined) return undefined;
    const exp = this.expiresAt[slot]!;
    if (exp !== Infinity && this.now() >= exp) {
      this.kill(slot);
      return undefined;
    }
    if (this.freq[slot]! < 3) this.freq[slot]!++;
    return this.values[slot];
  }

  /** True if the entry exists but is past its stale time: serve it, and revalidate in the background. */
  isStale(key: K): boolean {
    const slot = this.index.get(key);
    if (slot === undefined) return false;
    const at = this.staleAt[slot]!;
    return at !== Infinity && this.now() >= at;
  }

  /** The value if present and not stale, without counting as a read. */
  peek(key: K): V | undefined {
    const slot = this.index.get(key);
    if (slot === undefined) return undefined;
    const at = this.staleAt[slot]!;
    return at === Infinity || this.now() < at ? this.values[slot] : undefined;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V, bytes = 1, ttl?: { staleAfterMs?: number; expireAfterMs?: number }): void {
    const expireAfter = ttl?.expireAfterMs ?? this.expireAfterMs;
    const staleAfter = Math.min(ttl?.staleAfterMs ?? this.staleAfterMs, expireAfter);
    const now = expireAfter === Infinity && staleAfter === Infinity ? 0 : this.now();
    const size = Math.max(1, bytes | 0);
    if (size > this.maxBytes) return; // Larger than the whole cache: never admitted.
    const existing = this.index.get(key);
    if (existing !== undefined) {
      const delta = size - this.bytesOf[existing]!;
      if ((this.flags[existing]! & IN_MAIN) !== 0) this.mainBytes += delta;
      else this.smallBytes += delta;
      this.values[existing] = value;
      this.bytesOf[existing] = size;
      this.staleAt[existing] = now + staleAfter;
      this.expiresAt[existing] = now + expireAfter;
      this.evict();
      return;
    }
    const slot = this.allocate();
    this.keys[slot] = key;
    this.values[slot] = value;
    this.bytesOf[slot] = size;
    this.freq[slot] = 0;
    this.staleAt[slot] = now + staleAfter;
    this.expiresAt[slot] = now + expireAfter;
    this.index.set(key, slot);
    if (this.ghost.delete(key)) {
      this.flags[slot] = LIVE | IN_MAIN;
      this.main.push(slot);
      this.mainBytes += size;
    } else {
      this.flags[slot] = LIVE;
      this.small.push(slot);
      this.smallBytes += size;
    }
    this.evict();
  }

  delete(key: K): boolean {
    const slot = this.index.get(key);
    if (slot === undefined) return false;
    this.kill(slot);
    return true;
  }

  /** Removes every entry whose key matches. O(n): for forget-a-user, not for the hot path. */
  deleteWhere(match: (key: K) => boolean): number {
    let n = 0;
    for (const [key, slot] of [...this.index]) {
      if (match(key)) {
        this.kill(slot);
        n++;
      }
    }
    for (const key of [...this.ghost.keys()]) if (match(key)) this.ghost.delete(key);
    return n;
  }

  /** Marks a slot dead and drops its key and value now; the slot itself is freed when it reaches a FIFO head. */
  private kill(slot: number): void {
    this.index.delete(this.keys[slot]!);
    if ((this.flags[slot]! & IN_MAIN) !== 0) this.mainBytes -= this.bytesOf[slot]!;
    else this.smallBytes -= this.bytesOf[slot]!;
    this.flags[slot]! &= ~LIVE;
    this.keys[slot] = undefined;
    this.values[slot] = undefined;
  }

  private release(slot: number): void {
    this.flags[slot] = 0;
    this.keys[slot] = undefined;
    this.values[slot] = undefined;
    this.free.push(slot);
  }

  private allocate(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.slots === this.bytesOf.length) this.grow(this.slots * 2);
    return this.slots++;
  }

  private grow(n: number): void {
    const i32 = (a: Int32Array) => {
      const b = new Int32Array(n);
      b.set(a);
      return b;
    };
    const u8 = (a: Uint8Array) => {
      const b = new Uint8Array(n);
      b.set(a);
      return b;
    };
    const f64 = (a: Float64Array) => {
      const b = new Float64Array(n);
      b.set(a);
      return b;
    };
    this.bytesOf = i32(this.bytesOf);
    this.freq = u8(this.freq);
    this.flags = u8(this.flags);
    this.staleAt = f64(this.staleAt);
    this.expiresAt = f64(this.expiresAt);
  }

  private evict(): void {
    while (this.smallBytes + this.mainBytes > this.maxBytes) {
      if (this.smallBytes > this.smallTarget || this.mainBytes === 0) this.evictSmall();
      else this.evictMain();
    }
  }

  private evictSmall(): void {
    const slot = this.small.shift();
    if (slot < 0) return this.evictMain();
    if ((this.flags[slot]! & LIVE) === 0) return this.release(slot);
    const size = this.bytesOf[slot]!;
    this.smallBytes -= size;
    if (this.freq[slot]! > 0) {
      // Read while in small: promote to main.
      this.flags[slot]! |= IN_MAIN;
      this.freq[slot] = 0;
      this.main.push(slot);
      this.mainBytes += size;
      return;
    }
    const key = this.keys[slot]!;
    this.index.delete(key);
    this.release(slot);
    this.remember(key);
  }

  private evictMain(): void {
    for (;;) {
      const slot = this.main.shift();
      if (slot < 0) return this.evictSmallOnly();
      if ((this.flags[slot]! & LIVE) === 0) {
        this.release(slot);
        continue;
      }
      if (this.freq[slot]! > 0) {
        this.freq[slot]!--;
        this.main.push(slot); // Lazy promotion: reinsert instead of evicting.
        continue;
      }
      this.mainBytes -= this.bytesOf[slot]!;
      this.index.delete(this.keys[slot]!);
      this.release(slot);
      return;
    }
  }

  private evictSmallOnly(): void {
    const slot = this.small.shift();
    if (slot < 0) return;
    if ((this.flags[slot]! & LIVE) !== 0) {
      this.smallBytes -= this.bytesOf[slot]!;
      this.index.delete(this.keys[slot]!);
    }
    this.release(slot);
  }

  /** The ghost: keys recently evicted from small, about as many as main holds, in a FIFO ring. */
  private remember(key: K): void {
    const cap = Math.max(16, this.index.size);
    if (this.ghostKeys.length < cap) {
      const size = cap * 2;
      const keys: (K | undefined)[] = new Array(size);
      const seqs = new Float64Array(size);
      for (let i = 0; i < this.ghostLength; i++) {
        const from = (this.ghostHead + i) % this.ghostKeys.length;
        keys[i] = this.ghostKeys[from];
        seqs[i] = this.ghostSeqs[from]!;
      }
      this.ghostKeys = keys;
      this.ghostSeqs = seqs;
      this.ghostHead = 0;
    }
    while (this.ghostLength >= cap) {
      const old = this.ghostKeys[this.ghostHead]!;
      // Only the key's newest ring entry removes it: an older one (the key was evicted, returned, evicted again)
      // must not erase the newer ghost record.
      if (this.ghost.get(old) === this.ghostSeqs[this.ghostHead]) this.ghost.delete(old);
      this.ghostKeys[this.ghostHead] = undefined;
      this.ghostHead = (this.ghostHead + 1) % this.ghostKeys.length;
      this.ghostLength--;
    }
    const at = (this.ghostHead + this.ghostLength) % this.ghostKeys.length;
    const seq = ++this.ghostSeq;
    this.ghostKeys[at] = key;
    this.ghostSeqs[at] = seq;
    this.ghostLength++;
    this.ghost.set(key, seq);
  }
}
