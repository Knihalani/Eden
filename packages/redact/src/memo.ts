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

/** Runs `f` as an entry point: every memo is empty once the outermost one returns. */
export function withMemos<T>(f: () => T): T {
  depth++;
  try {
    return f();
  } finally {
    if (--depth === 0) {
      for (const memo of live) memo.clear();
      live.length = 0;
    }
  }
}

/** The answer for the last key asked, within one entry point. */
export class Last<V> {
  private key: string | undefined = undefined;
  private value: V | undefined = undefined;
  private holding = false;

  /** `compute(key)`, or the answer kept for `key` when it was the last key asked in this call. */
  get(key: string, compute: (key: string) => V): V {
    if (depth === 0) return compute(key);
    if (this.holding && key === this.key) return this.value as V;
    const value = compute(key);
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
  private readonly last = new Last<V>();
  private holding = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get(key: string, compute: (key: string) => V): V {
    if (depth === 0) return compute(key);
    return this.last.get(key, () => {
      let value = this.map.get(key);
      if (value === undefined) {
        if (this.map.size >= this.limit) this.map.clear();
        value = compute(key);
        this.map.set(key, value);
        if (!this.holding) {
          this.holding = true;
          live.push(this);
        }
      }
      return value;
    });
  }

  clear(): void {
    this.holding = false;
    this.map.clear();
  }
}
