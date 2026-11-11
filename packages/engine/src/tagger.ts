/**
 * The constraint tagger (`constraintTag`, M3, D908; docs/research/m3-arch.md §6, §7h). A small network trained end to
 * end on generated worlds reads one item and gives its probability of being a binding fact for some request (its
 * `fact` tag) rather than an all-clear, a look-alike or background. The push gate uses it as a veto: a pooled item the
 * existing constraint test passes is no longer constraint-like when the tagger reads it under the threshold.
 *
 * No model call and no network: hashed word and character n-grams (CRC-32, as the training code's `zlib.crc32`), a
 * ternary encoder summed over them, a folded norm and a sign (256 bits), one binary layer of 64 units, and a 9-way
 * head. The weights ship in the package (`models/tags-v1.bin`, about 4 MB: two bits a ternary weight, one a binary
 * one), are read once per process and unpacked to about 17 MB, shared by every user. An item costs about 0.3-0.8 ms,
 * read once per item version (`TagMemo`), in the background after the item is stored; the push gate reads the memo
 * and tags inline only what the background has not reached (at most the pool's 15 items).
 */
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { scopeKey } from "@eden/protocol";

type Scope = { tenantId: string; userId: string };

/** The shipped weights, beside the package's sources. */
export const TAGGER_PATH = new URL("../models/tags-v1.bin", import.meta.url).pathname;

interface Header {
  version: number;
  bits: number;
  buckets: number;
  hidden: number;
  tags: string[];
  floats: { name: string; length: number }[];
  checks: { text: string; logits: number[] }[];
}

const WORD = /[a-z0-9£$€]+/g;
const MAX_WORDS = 150;
const MAX_GRAMS = 300;

/** The training code's features: words, character 3- and 4-grams inside words, word bigrams; hashed, sorted, capped. */
export function grams(text: string, buckets: number): number[] {
  const words = (text.toLowerCase().match(WORD) ?? []).slice(0, MAX_WORDS);
  const out = new Set<number>();
  for (const w of words) {
    out.add(Bun.hash.crc32(`w${w}`) % buckets);
    const p = `<${w}>`;
    for (const n of [3, 4])
      for (let k = 0; k + n <= p.length; k++) out.add(Bun.hash.crc32(`c${p.slice(k, k + n)}`) % buckets);
  }
  for (let k = 0; k + 1 < words.length; k++) out.add(Bun.hash.crc32(`b${words[k]} ${words[k + 1]}`) % buckets);
  return [...out].sort((a, b) => a - b).slice(0, MAX_GRAMS);
}

/** The network: `logits(text)` and `factProbability(text)`. Not tied to any user; one per process. */
export class ItemTagger {
  readonly header: Header;
  private readonly enc: Int8Array;
  private readonly l1: Int8Array;
  private readonly f: Record<string, Float32Array> = {};
  private readonly acc: Float32Array;
  private readonly code: Float32Array;
  private readonly h: Float32Array;

  constructor(bytes: Uint8Array) {
    const magic = new TextDecoder().decode(bytes.subarray(0, 4));
    if (magic !== "EDT1") throw new Error("tagger: not a tagger file");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headLen = view.getUint32(4, true);
    this.header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen))) as Header;
    const { bits: B, buckets, hidden } = this.header;
    let at = 8 + headLen;
    at += (4 - (at % 4)) % 4;
    const n = buckets * B;
    this.enc = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const v = (bytes[at + (i >> 2)]! >> ((i & 3) * 2)) & 3;
      this.enc[i] = v === 1 ? 1 : v === 2 ? -1 : 0;
    }
    at += Math.ceil(n / 4);
    const m = hidden * B;
    this.l1 = new Int8Array(m);
    for (let i = 0; i < m; i++) this.l1[i] = (bytes[at + (i >> 3)]! >> (i & 7)) & 1 ? 1 : -1;
    at += Math.ceil(m / 8);
    at += (4 - (at % 4)) % 4;
    for (const { name, length } of this.header.floats) {
      this.f[name] = new Float32Array(bytes.buffer.slice(bytes.byteOffset + at, bytes.byteOffset + at + length * 4));
      at += length * 4;
    }
    if (at !== bytes.byteLength) throw new Error("tagger: file length does not match its header");
    this.acc = new Float32Array(B);
    this.code = new Float32Array(B);
    this.h = new Float32Array(hidden);
  }

  logits(text: string): number[] {
    const { bits: B, buckets, hidden } = this.header;
    const { enc, l1, acc, code, h } = this;
    const f = this.f;
    acc.fill(0);
    for (const g of grams(text, buckets)) {
      const base = g * B;
      for (let b = 0; b < B; b++) acc[b]! += enc[base + b]!;
    }
    const s0 = f.enc_scale![0]!;
    for (let b = 0; b < B; b++) code[b] = acc[b]! * s0 * f.enc_bn_s![b]! + f.enc_bn_h![b]! >= 0 ? 1 : -1;
    for (let o = 0; o < hidden; o++) {
      let s = 0;
      const base = o * B;
      for (let i = 0; i < B; i++) s += code[i]! * l1[base + i]!;
      h[o] = s * f.l1_scale![o]! * f.l1_bn_s![o]! + f.l1_bn_h![o]! >= 0 ? 1 : -1;
    }
    const out: number[] = [];
    const W = f.head_w!;
    for (let c = 0; c < this.header.tags.length; c++) {
      let s = f.head_b![c]!;
      for (let o = 0; o < hidden; o++) s += h[o]! * W[c * hidden + o]!;
      out.push(s);
    }
    return out;
  }

  /** The softmax probability of the first tag (`fact`) for an item as training read it: title, a newline, text. */
  factProbability(item: Pick<ContextItem, "title" | "text">): number {
    const l = this.logits(`${item.title ?? ""}\n${item.text}`);
    const top = Math.max(...l);
    let sum = 0;
    for (const x of l) sum += Math.exp(x - top);
    return Math.exp(l[0]! - top) / sum;
  }

  /**
   * What the veto reads: the probability that the item is not an all-clear or look-alike (one minus the softmax mass
   * of `ALL_CLEAR` tags), so a binding fact and an item of no named kind (`other`: background, and most short
   * snippets, which training's `other` items resembled) both read high. Reading `fact` alone vetoed short real
   * constraints ("Do not pay Zed Quinn: … on hold" 0.16), the hazard this reading removes (docs/research/m3-arch.md §7h).
   */
  constraintProbability(item: Pick<ContextItem, "title" | "text">): number {
    const l = this.logits(`${item.title ?? ""}\n${item.text}`);
    const top = Math.max(...l);
    let sum = 0;
    let clear = 0;
    for (let k = 0; k < l.length; k++) {
      const e = Math.exp(l[k]! - top);
      sum += e;
      if (ALL_CLEAR.has(this.header.tags[k]!)) clear += e;
    }
    return 1 - clear / sum;
  }
}

/** The tags that read an item as an all-clear or a look-alike of the request's fact. */
export const ALL_CLEAR = new Set([
  "superseded",
  "other-entity",
  "resolved",
  "other-period",
  "already-met",
  "neutral",
  "twin",
]);

let shared: ItemTagger | null | undefined;

/**
 * The process's tagger, read from `path` (default the shipped file) on first use and shared after; null, logged once,
 * when the file is missing or unreadable: the gate then vetoes nothing (fail open).
 */
export function sharedTagger(path = TAGGER_PATH, log: (msg: string) => void = console.error): ItemTagger | null {
  if (shared === undefined) shared = readTagger(path, log);
  return shared;
}

/** Reads a tagger file; null, with one log line, when it is missing or unreadable. */
export function readTagger(path: string, log: (msg: string) => void = console.error): ItemTagger | null {
  try {
    return new ItemTagger(readFileSync(path));
  } catch (e) {
    log(`eden: the constraint tagger could not be read (${(e as Error).message}); the push gate's veto is off`);
    return null;
  }
}

/** A 32-bit FNV-1a of an item's title and text: a version stamp, so an edited item is read again. */
function stamp(item: Pick<ContextItem, "title" | "text">): number {
  let h = 0x811c9dc5;
  const s = `${item.title ?? ""}\n${item.text}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Items a user's memo holds at most (oldest dropped first): a user's synced cache is about 3,000 items. */
export const TAG_MEMO_PER_USER = 8_192;
/** Items the background tags per event-loop turn (about 0.3-0.8 ms each). */
const TAG_SLICE = 6;

/**
 * Per user (D9): each item's tag reading, by id, with its version stamp, as one number (stamp × 256 + the probability
 * in 1/255 steps), so the memo holds no text. Filled in the background after a store (`ingest`), read by the gate
 * (`read`), dropped with the user's items (`forget`).
 */
export class TagMemo {
  private readonly users = new Map<string, Map<string, number>>();
  private readonly queue: { key: string; item: ContextItem }[] = [];
  private draining = false;
  /** Items tagged, and the time spent (ms): what COST-MODEL.md's CPU line reads. */
  readonly stats = { tagged: 0, ms: 0 };

  constructor(
    private readonly tagger: ItemTagger,
    private readonly perUser = TAG_MEMO_PER_USER,
  ) {}

  private memo(key: string): Map<string, number> {
    let m = this.users.get(key);
    if (!m) this.users.set(key, (m = new Map()));
    return m;
  }

  private tag(key: string, item: ContextItem): number {
    const t0 = performance.now();
    const p = this.tagger.constraintProbability(item);
    this.stats.ms += performance.now() - t0;
    this.stats.tagged++;
    const m = this.memo(key);
    m.delete(item.id);
    m.set(item.id, stamp(item) * 256 + Math.round(p * 255));
    while (m.size > this.perUser) m.delete(m.keys().next().value!);
    return Math.round(p * 255) / 255;
  }

  private cached(key: string, item: ContextItem): number | null {
    const v = this.users.get(key)?.get(item.id);
    if (v === undefined || Math.floor(v / 256) !== stamp(item)) return null;
    return (v % 256) / 255;
  }

  /** The gate's reading: the memo's, or tagged now when the background has not reached the item yet. */
  read(scope: Scope, item: ContextItem): number {
    const key = scopeKey(scope);
    return this.cached(key, item) ?? this.tag(key, item);
  }

  /** Queues stored items for the background, a few per event-loop turn, off the request path. */
  ingest(scope: Scope, items: readonly ContextItem[]): void {
    const key = scopeKey(scope);
    for (const item of items) this.queue.push({ key, item });
    if (!this.draining && this.queue.length > 0) {
      this.draining = true;
      setImmediate(() => this.drain());
    }
  }

  private drain(): void {
    for (let k = 0; k < TAG_SLICE && this.queue.length > 0; k++) {
      const { key, item } = this.queue.shift()!;
      // `forget` takes a forgotten user's items out of the queue, so what is left is still theirs.
      if (this.cached(key, item) === null) this.tag(key, item);
    }
    if (this.queue.length > 0) setImmediate(() => this.drain());
    else this.draining = false;
  }

  /** Drops a user's readings (all, or those of `ids`), and anything of theirs still queued. */
  forget(scope: Scope, ids?: readonly string[]): void {
    const key = scopeKey(scope);
    if (ids) {
      const m = this.users.get(key);
      for (const id of ids) m?.delete(id);
      if (m && m.size === 0) this.users.delete(key);
      const gone = new Set(ids);
      for (let i = this.queue.length - 1; i >= 0; i--)
        if (this.queue[i]!.key === key && gone.has(this.queue[i]!.item.id)) this.queue.splice(i, 1);
      return;
    }
    this.users.delete(key);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.key === key) this.queue.splice(i, 1);
  }

  /** Users and items held (for the isolation and memory tests). */
  size(): { users: number; items: number } {
    let items = 0;
    for (const m of this.users.values()) items += m.size;
    return { users: this.users.size, items };
  }
}
