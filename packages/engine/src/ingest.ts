/**
 * Ingest off the event loop (trial `ingestWorker`, D216). The fan-out's gate hook sends each page a source returned
 * (a lookup's results, a sync listing) to a worker, which redacts every item first (`sanitizeItem`, D10: the worker
 * reads nothing else of the raw item) and then reads the redacted copy as the cache would on `put`: its terms with
 * their hash lanes (`tokenizeInto` into a scratch vocabulary), its graph reading (`extract`), its entity mentions
 * (`mentionsOf`) and its deflated text (`packedBytes`). The event loop then only applies the reading: it interns the
 * distinct terms in the order the tokenizer would have, indexes, places the graph reading and wraps the bytes.
 *
 * The same stored state as on the event loop: the vocabulary takes the same ids (a term's first occurrence, title then
 * body, decides its id either way), the index the same postings, the graph the same nodes and edges, the text the same
 * bytes (ingest.test.ts compares both over the bench workload and the sim world). A graph reading of an item that binds
 * a date resolves "today" and the nearest year at its own clock, so the cache uses it only at that same `now` and
 * reads such an item again otherwise.
 *
 * Fail closed as the gate pool (D26): a chunk that fails (past the pool's deadline, a crashed worker, an abort) fails
 * the page, and nothing ungated is stored. A full pool redacts on the calling thread instead, with no reading. Pages
 * under `inlineBelow` characters are redacted inline too: the round trip would cost more than the work.
 *
 * This module is the pool's task module (`INGEST_MODULE`): workers import it for `prepareItems`. Workers keep no state
 * between tasks; the graph memo lives for one task (one user's chunk).
 */
import { FOLD, FOLD_DROP, foldOf, PoolFullError, termHash, Vocab, WorkerPool } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import { warmGate } from "@eden/redact";
import { DEFAULT_CACHE_LIMITS, sanitizeItem } from "./cache";
import { extract, type Memo, type NodeKind } from "./kg";
import { packedBytes } from "./packed-text";
import { attachPrepared, type PreparedChunk } from "./prepared";
import { extractTypedEntities, head, PERSISTABLE_KINDS, termIds } from "./text";

/** The module an ingest pool's workers import (`PoolOptions.module`). */
export const INGEST_MODULE = import.meta.url;

/** Items per task: a page's items spread over the pool's workers in chunks, each read with one graph memo. */
const CHUNK = 16;

/** The entity mentions an item's source records (`ContextPartner.recordMentions`): at most 20 persistable ones. */
export function mentionsOf(item: ContextItem): string[] {
  return extractTypedEntities(`${item.title}. ${item.text}`)
    .filter((e) => PERSISTABLE_KINDS.has(e.kind))
    .slice(0, 20)
    .map((e) => e.text);
}

/** What a task reads, besides the items. */
export interface IngestOptions {
  maxTextChars: number;
  /** The engine's clock when the page was read (the graph resolves dates against it). */
  now: number;
  /** Read for the graph (`config.graph`). */
  graph: boolean;
  /** Read mentions (the partner records them for every stored item). */
  mentions: boolean;
  /** Deflate the text (`CacheLimits.packText`). */
  pack: boolean;
}

const lanes = new Uint32Array(2);

/** Folded length as the tokenizer counts it (characters that fold to nothing do not count). */
function foldedLength(term: string): number {
  let n = 0;
  for (let i = 0; i < term.length; i++) {
    const c = term.charCodeAt(i);
    if ((c < 128 ? FOLD[c]! : foldOf(c)) !== FOLD_DROP) n++;
  }
  return n;
}

const KIND_CODE: Record<NodeKind, number> = { name: 0, email: 1, id: 2, channel: 3, role: 4, day: 5 };

/** Writes a chunk (`PreparedChunk`): its term vocabulary, its other strings, and each item's record. */
class ChunkWriter {
  /** The chunk's terms: interning gives each its chunk number, in order of first occurrence. */
  readonly vocab = new Vocab(1_024);
  private readonly strings: string[] = [];
  private readonly stringIds = new Map<string, number>();
  private readonly records: number[] = [];
  private readonly at: number[] = [];
  private stamps = new Uint32Array(1_024);
  private stamp = 0;

  /** The number of a string in the chunk's table, added once. */
  private str(s: string): number {
    let id = this.stringIds.get(s);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(s);
      this.stringIds.set(s, id);
    }
    return id;
  }

  /** Writes one redacted item's record (see prepared.ts). */
  item(item: ContextItem, opt: IngestOptions, memo: Memo): void {
    const out = this.records;
    this.at.push(out.length);
    const t = termIds(item.title, this.vocab, true);
    const title = t.ids.slice(0, t.n);
    const b = termIds(item.text, this.vocab, true);
    const body = b.ids.subarray(0, b.n);
    if (this.stamps.length < this.vocab.size) this.stamps = new Uint32Array(this.vocab.size * 2);
    const stamp = ++this.stamp;
    // Distinct terms in order of first occurrence, title then body: the order the user's vocabulary interns them in.
    const distinctAt = out.length;
    out.push(0);
    for (const ids of [title, body]) {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        if (this.stamps[id] === stamp) continue;
        this.stamps[id] = stamp;
        out.push(id);
      }
    }
    out[distinctAt] = out.length - distinctAt - 1;
    out.push(title.length);
    for (let i = 0; i < title.length; i++) out.push(title[i]!);
    out.push(body.length);
    for (let i = 0; i < body.length; i++) out.push(body[i]!);
    if (opt.mentions) {
      const m = mentionsOf(item);
      out.push(m.length);
      for (const s of m) out.push(this.str(s));
    } else out.push(-1);
    if (opt.graph) {
      const x = extract(item, opt.now, memo);
      out.push(x.nodes.size);
      for (const [key, n] of x.nodes) out.push(this.str(key), KIND_CODE[n.kind], this.str(n.label), n.mask);
      out.push(x.links.length);
      for (const [a, z, mask] of x.links) out.push(this.str(a), this.str(z), mask);
      out.push(x.authors.length);
      for (const a of x.authors) out.push(this.str(a));
      out.push(x.automated ? 1 : 0, x.bound ? 1 : 0);
      this.long.push(x.long.length > 0 ? x.long : null);
    } else {
      out.push(-1);
      this.long.push(null);
    }
    if (opt.pack) this.packed.push(packedBytes(item.text));
  }

  readonly long: ({ from: string; to: string }[] | null)[] = [];
  readonly packed: ({ bytes: Uint8Array<ArrayBuffer>; latin1: boolean } | null)[] = [];

  done(opt: IngestOptions): PreparedChunk {
    const v = this.vocab;
    const termAt = new Uint32Array(v.size + 1);
    const lane = new Uint32Array(v.size * 3);
    const parts: string[] = [];
    let at = 0;
    for (let id = 0; id < v.size; id++) {
      const term = v.term(id);
      parts.push(term);
      termAt[id] = at;
      at += term.length;
      termHash(term, 0, term.length, lanes);
      lane[id * 3] = lanes[0]!;
      lane[id * 3 + 1] = lanes[1]!;
      lane[id * 3 + 2] = foldedLength(term);
    }
    termAt[v.size] = at;
    const terms = parts.join("");
    const stringAt = new Uint32Array(this.strings.length + 1);
    at = 0;
    for (let s = 0; s < this.strings.length; s++) {
      stringAt[s] = at;
      at += this.strings[s]!.length;
    }
    stringAt[this.strings.length] = at;
    const chunk: PreparedChunk = {
      now: opt.now,
      terms,
      termAt,
      lanes: lane,
      strings: this.strings.join(""),
      stringAt,
      records: Int32Array.from(this.records),
      at: Uint32Array.from(this.at),
      long: this.long,
    };
    if (opt.pack) chunk.packed = this.packed;
    return chunk;
  }
}

/** Pool task: a chunk of raw items, each redacted and then read; the readings packed as one `PreparedChunk`. */
export function prepareItems(input: { items: ContextItem[]; opt: IngestOptions }): {
  items: ContextItem[];
  chunk: PreparedChunk;
} {
  const memo: Memo = { sentences: new Map(), people: new Map() };
  const w = new ChunkWriter();
  const items = input.items.map((raw) => {
    const item = sanitizeItem(raw, input.opt.maxTextChars);
    w.item(item, input.opt, memo);
    return item;
  });
  return { items, chunk: w.done(input.opt) };
}

/** Holds each item of a chunk the worker returned with its view of the chunk (`attachPrepared`). */
export function attachChunk(items: ContextItem[], chunk: PreparedChunk): void {
  for (let k = 0; k < items.length; k++) attachPrepared(items[k]!, { chunk, k });
}

let warmed = false;

/** Pool task: whether `warmIngest` has run on this thread. */
export function ingestWarmed(): boolean {
  return warmed;
}

/** Pool warm task: compiles the secret gate and reads one sample item, so a worker's first page pays for neither. */
export function warmIngest(): void {
  warmed = true;
  warmGate();
  const sample = "From: Sam Lee <sam@example.com>\nwarm-up: an api key, a token and a password, none of them real.";
  prepareItems({
    items: [{ id: "warm", sourceId: "warm", ref: "warm", title: "Warm-up", text: sample }],
    opt: { maxTextChars: 400, now: Date.UTC(2026, 0, 1), graph: true, mentions: true, pack: true },
  });
}

/**
 * A `SourceFanout` sanitize hook that redacts and reads each page's items in `pool` (`prepareItems`) and attaches each
 * reading to its redacted item (`attachPrepared`) for the cache. Rejects when any chunk fails (fail closed).
 */
export function pooledIngest(
  pool: Pick<WorkerPool, "run">,
  options: { inlineBelow: number; maxTextChars?: number; now: () => number } & Omit<
    IngestOptions,
    "now" | "maxTextChars"
  >,
): (items: ContextItem[], signal?: AbortSignal) => ContextItem[] | Promise<ContextItem[]> {
  const maxTextChars = options.maxTextChars ?? DEFAULT_CACHE_LIMITS.maxTextChars;
  const inline = (items: ContextItem[]) => items.map((i) => sanitizeItem(i, maxTextChars));
  return (items, signal) => {
    let cost = 0;
    for (const raw of items) cost += Math.min(String(raw.text).length, maxTextChars) + 50;
    if (cost < options.inlineBelow) return inline(items);
    const opt: IngestOptions = {
      maxTextChars,
      now: options.now(),
      graph: options.graph,
      mentions: options.mentions,
      pack: options.pack,
    };
    const chunks: ContextItem[][] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      // Clipped before the copy to the worker: `sanitizeItem` clips to the same lengths, so the result is unchanged.
      chunks.push(
        items.slice(i, i + CHUNK).map((raw) => ({
          ...raw,
          title: head(raw.title, 500),
          text: head(raw.text, maxTextChars),
        })),
      );
    }
    return (async () => {
      const done = await Promise.allSettled(
        chunks.map((chunk) =>
          pool.run<{ items: ContextItem[]; chunk: PreparedChunk }>("prepareItems", { items: chunk, opt }, signal),
        ),
      );
      const out: ContextItem[] = [];
      let failed = 0;
      for (let k = 0; k < done.length; k++) {
        const d = done[k]!;
        if (d.status === "fulfilled") {
          attachChunk(d.value.items, d.value.chunk);
          for (const item of d.value.items) {
            out.push(item);
          }
        } else if (d.reason instanceof PoolFullError) {
          // Back-pressure, not a failure of the gate: these are redacted here, with no reading (the cache reads them).
          out.push(...inline(chunks[k]!));
        } else failed++;
      }
      if (failed > 0) throw new Error(`ingest failed for ${failed} of ${chunks.length} chunks`);
      return out;
    })();
  };
}

/**
 * Starts the ingest worker pool (trial `ingestWorker`): one worker per process by default. A message of chunks running
 * past `taskTimeoutMs` has its worker replaced and its pages fail closed (nothing ungated is stored); a full queue
 * redacts on the event loop instead. Every worker, a replacement too, compiles the secret gate and reads a sample item
 * before it serves (`warmIngest`).
 */
export function startIngestWorkers(size = 1, taskTimeoutMs = 5_000): Promise<WorkerPool> {
  return WorkerPool.start({
    module: INGEST_MODULE,
    size,
    maxQueue: 4_096,
    maxBatch: 4,
    taskTimeoutMs,
    inlineBelow: 0,
    warm: "warmIngest",
  });
}
