/**
 * Meaning-based ranking of a user's items (F2, docs/research/f2-semantic-pool.md), shared by any engine path that
 * wants it (a push pool's picks, a rule index over constraint cards): items are embedded in the background, rate
 * limited, and kept as int8 codes per user; a request is embedded on call (about 5 ms) and scored against the codes.
 *
 * - Never on the request path for items: `ingest` only queues; a timer works the queue, at most `perSecond` items a
 *   second in batches of `batch`. An item not embedded yet is simply absent from `rank`'s answer (the caller's lexical
 *   path stands).
 * - Isolation (D9): codes and queues are per tenant/user; `rank` reads only its scope's codes, and the caller still
 *   checks every returned id against its own user's live items.
 * - Unchanged items are skipped by a 32-bit stamp of the embedded text.
 * - Text is the caller's: it must be redacted before it reaches `ingest` or `rank` (D10); nothing here stores text.
 */
import type { Scope } from "@eden/protocol";
import { project, UserCodes, type Projection } from "./codes";
import { PASSAGE, QUERY, type Encoder } from "./encoder";

/** One item to embed: its id and its (redacted) title and text. */
export interface RankItem {
  id: string;
  title: string;
  text: string;
}

export interface RankerOptions {
  /** Items embedded a second at most, across users (CPU budget for the background work). */
  perSecond: number;
  /** Items a batch (one model call). */
  batch: number;
  /** Items queued a user at most; older queued ones are dropped first. */
  maxQueued: number;
}

export const DEFAULT_RANKER: RankerOptions = { perSecond: 20, batch: 8, maxQueued: 5_000 };

/** Mail header lines are not what an item is about (F1's rule, the measured `k5f` text). */
const HEADER = /^\s*(from|to|cc|bcc|date|subject|sent|reply-to):/i;

/** What is embedded for an item: its title and its first 600 characters less mail header lines. */
export function itemText(title: string, text: string): string {
  const body = text
    .split("\n")
    .filter((line) => !HEADER.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return `${PASSAGE}${title}. ${body.slice(0, 600)}`;
}

/** FNV-1a over the text's UTF-16 units: the stamp an unchanged item is skipped by. */
export function stamp(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const keyOf = (scope: Scope) => `${scope.tenantId}/${scope.userId}`;

export class EncoderRanker {
  private readonly users = new Map<string, UserCodes>();
  private readonly queues = new Map<string, Map<string, RankItem>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Batches taken from a queue whose model call has not returned. */
  private readonly flying = new Set<Promise<void>>();
  readonly stats = { embedded: 0, skipped: 0, dropped: 0, ranked: 0, failures: 0 };
  private readonly options: RankerOptions;

  constructor(
    private readonly encoder: Encoder,
    private readonly projection: Projection | null = null,
    options: Partial<RankerOptions> = {},
  ) {
    this.options = { ...DEFAULT_RANKER, ...options };
  }

  /** Per user, bumped by `forget`: a batch that began before it stores nothing. */
  private readonly epochs = new Map<string, number>();

  /** Queues items to embed in the background; returns at once. */
  ingest(scope: Scope, items: readonly RankItem[]): void {
    if (this.stopped || items.length === 0) return;
    const k = keyOf(scope);
    let q = this.queues.get(k);
    if (!q) this.queues.set(k, (q = new Map()));
    for (const it of items) {
      q.delete(it.id);
      q.set(it.id, it);
    }
    while (q.size > this.options.maxQueued) {
      q.delete(q.keys().next().value as string);
      this.stats.dropped++;
    }
    this.schedule();
  }

  /** Forgets a user's codes and queue (`forget`, a dropped user). */
  forget(scope: Scope): void {
    const k = keyOf(scope);
    this.users.delete(k);
    this.queues.delete(k);
    this.epochs.set(k, (this.epochs.get(k) ?? 0) + 1);
  }

  /** Drops items a user no longer holds. */
  remove(scope: Scope, ids: readonly string[]): void {
    const u = this.users.get(keyOf(scope));
    const q = this.queues.get(keyOf(scope));
    for (const id of ids) {
      u?.remove(id);
      q?.delete(id);
    }
  }

  /** The scope's embedded item ids closest to `request` (redacted), best first; [] before any is embedded. */
  async rank(scope: Scope, request: string, limit: number, signal?: AbortSignal): Promise<string[]> {
    const u = this.users.get(keyOf(scope));
    if (!u || u.size === 0 || signal?.aborted) return [];
    const [q] = await this.encoder.embed([QUERY + request]);
    if (signal?.aborted) return [];
    this.stats.ranked++;
    return u.top(project(q!, this.projection), limit);
  }

  /** Embedded items of a scope (tests and reports). */
  held(scope: Scope): number {
    return this.users.get(keyOf(scope))?.size ?? 0;
  }

  /** Bytes of codes a scope holds. */
  bytes(scope: Scope): number {
    return this.users.get(keyOf(scope))?.bytes ?? 0;
  }

  /** Waits until every queue is empty (tests and benches). */
  async drained(): Promise<void> {
    while (!this.stopped && ([...this.queues.values()].some((q) => q.size > 0) || this.flying.size > 0)) {
      if ([...this.queues.values()].some((q) => q.size > 0)) await this.step();
      else await Promise.race(this.flying);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    const wait = Math.ceil((1000 * this.options.batch) / this.options.perSecond);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step().then(() => {
        if ([...this.queues.values()].some((q) => q.size > 0)) this.schedule();
      });
    }, wait);
    // The background work never keeps a process alive on its own.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One batch, tracked until its model call returns. */
  private step(): Promise<void> {
    const p = this.work().finally(() => this.flying.delete(p));
    this.flying.add(p);
    return p;
  }

  /** One batch from the first user with work (users take turns: the user worked is moved to the back). */
  private async work(): Promise<void> {
    const entry = [...this.queues.entries()].find(([, q]) => q.size > 0);
    if (!entry) return;
    const [k, q] = entry;
    this.queues.delete(k);
    this.queues.set(k, q);
    const batch: { it: RankItem; text: string; st: number }[] = [];
    const epoch = this.epochs.get(k) ?? 0;
    const held = this.users.get(k);
    for (const it of q.values()) {
      if (batch.length >= this.options.batch) break;
      q.delete(it.id);
      const text = itemText(it.title, it.text);
      const st = stamp(text);
      if (held?.stampOf(it.id) === st) {
        this.stats.skipped++;
        continue;
      }
      batch.push({ it, text, st });
    }
    if (batch.length === 0) return;
    try {
      const vecs = await this.encoder.embed(batch.map((b) => b.text));
      // A user forgotten while the batch ran stores nothing.
      if ((this.epochs.get(k) ?? 0) !== epoch) return;
      const codes = batch.map((_, i) => project(vecs[i]!, this.projection));
      let u = this.users.get(k);
      // The codes take the model's (or the projection's) width from the first vector.
      if (!u) this.users.set(k, (u = new UserCodes(codes[0]!.length)));
      batch.forEach((b, i) => u.put(b.it.id, codes[i]!, b.st));
      this.stats.embedded += batch.length;
    } catch (err) {
      this.stats.failures++;
    }
  }
}
