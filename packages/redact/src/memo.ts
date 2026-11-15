/**
 * D1850: the gate's memos last one call. A memo that keeps the last value it judged (a slice of the caller's text)
 * keeps the whole text alive on JavaScriptCore, which shares a slice's storage with its parent: 60 distinct 1 MB
 * texts left 56 MB on the heap after a collection (the review of 2026-11-14; main 0.1 MB), and the texts are tenants'.
 *
 * So a memo answers only inside an entry point (`withMemos`: the gate's `sanitizeForStore`, `secretHits`,
 * `findings`), and every memo used in it is emptied when the outermost one returns, whatever it returns or throws.
 * Outside one, a memo computes and keeps nothing. Only the memos used in the call are emptied, so a call that finds
 * nothing pays nothing. `memo.test.ts` holds the retained heap flat.
 */

/** The memos holding something since the outermost entry point began. */
const live: { clear(): void }[] = [];
/** How many entry points are running (one calls another): the memos are emptied when the outermost returns. */
let depth = 0;

/** Runs `f(a)` as an entry point: every memo is empty once the outermost one returns. */
export function withMemos<T, A = undefined>(f: (a: A) => T, a?: A): T {
  depth++;
  try {
    return f(a as A);
  } finally {
    if (--depth === 0) {
      for (const memo of live) memo.clear();
      live.length = 0;
    }
  }
}

/**
 * The answer for the last key asked, within one entry point. A call site asks `has(key)`, then reads `value` or
 * stores its own answer with `set`: no callback, so each call site stays monomorphic (a `get(key, compute)` called
 * with a different `compute` per memo cost 25 µs a 16 KB text in calls the engine could not inline).
 */
export class Last<V> {
  private key: string | undefined = undefined;
  value: V | undefined = undefined;
  private holding = false;

  /** Whether `key` was the last key set in this call (never outside an entry point). */
  has(key: string): boolean {
    return this.holding && key === this.key;
  }

  /** Keeps `value` for `key` until the entry point returns (nothing outside one); returns `value`. */
  set(key: string, value: V): V {
    if (depth === 0) return value;
    this.key = key;
    this.value = value;
    if (!this.holding) {
      this.holding = true;
      live.push(this);
    }
    return value;
  }

  clear(): void {
    this.holding = false;
    this.key = undefined;
    this.value = undefined;
  }
}

/** The answers for up to `limit` keys (then it starts again), the last one first, within one entry point. */
export class Answers<V> {
  private readonly map = new Map<string, V>();
  private lastKey: string | undefined = undefined;
  private lastValue: V | undefined = undefined;
  private holding = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get<A>(key: string, compute: (key: string, a: A) => V, a?: A): V {
    if (depth === 0) return compute(key, a as A);
    if (this.holding && key === this.lastKey) return this.lastValue as V;
    let value = this.map.get(key);
    if (value === undefined) {
      if (this.map.size >= this.limit) this.map.clear();
      value = compute(key, a as A);
      this.map.set(key, value);
    }
    if (!this.holding) {
      this.holding = true;
      live.push(this);
    }
    this.lastKey = key;
    this.lastValue = value;
    return value;
  }

  clear(): void {
    this.holding = false;
    this.map.clear();
    this.lastKey = undefined;
    this.lastValue = undefined;
  }
}

/**
 * The answers for the last `size` keys asked, within one entry point, found by comparison (no Map: hashing a key cost
 * more than the answer on short values). For answers several passes ask about the same few values in one call: the
 * keyword rules, the assignment pass and the composer each judge a value as code or not (D1850).
 */
export class Recent<V> {
  private readonly keys: (string | undefined)[];
  private readonly values: (V | undefined)[];
  private next = 0;
  private holding = false;
  /** The slot `has` found last, for `value`. */
  private found = 0;

  constructor(size: number) {
    this.keys = new Array<string | undefined>(size).fill(undefined);
    this.values = new Array<V | undefined>(size).fill(undefined);
  }

  /** Whether `key` is one of the last keys set in this call (never outside an entry point); `value` is its answer. */
  has(key: string): boolean {
    if (!this.holding) return false;
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] === key) {
        this.found = i;
        return true;
      }
    }
    return false;
  }

  /** The answer for the key `has` found last. */
  get value(): V {
    return this.values[this.found] as V;
  }

  /** Keeps `value` for `key` until the entry point returns (nothing outside one); returns `value`. */
  set(key: string, value: V): V {
    if (depth === 0) return value;
    this.keys[this.next] = key;
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.keys.length;
    if (!this.holding) {
      this.holding = true;
      live.push(this);
    }
    return value;
  }

  clear(): void {
    this.holding = false;
    this.keys.fill(undefined);
    this.values.fill(undefined);
    this.next = 0;
  }
}
