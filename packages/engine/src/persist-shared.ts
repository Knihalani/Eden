/**
 * Frozen users in a store every machine reaches (D992): the hand-off between machines, and what a machine fails over
 * from. A `SharedFrozenDisk` is the local `EncryptedFrozenDisk` (the same files, read and written synchronously as
 * before) with every file it writes mirrored, byte for byte, to a `BlobStore` (S3-compatible: Cloudflare R2, the
 * provider's own, MinIO), and a user it does not hold fetched from there before their first read (`fetch`, which
 * `ItemCache.ready` awaits). The bytes are the encrypted file: the store sees what the disk sees (names with a bucket
 * and a keyed hash, sizes, times), never content or ids, and a file copied under another user's key fails to open.
 *
 * What lives where:
 * - Local: only users this process owns, and only from this process's start (the server empties the directory first
 *   in a cluster), so a local file is never older than the store's copy.
 * - Store: each user's last written blob (the compact freeze at 30 minutes idle, a release, or a shutdown's flush). A
 *   thaw deletes the local file but keeps the store's copy: it is the failover copy, the "last compact freeze" D864
 *   names. Forget, expiry and eviction delete both. Copies older than `maxAgeMs` are deleted by `sweepStore` (and
 *   should be by the bucket's own lifecycle rule too, docs/DEPLOY.md).
 *
 * Writes to the store are behind the request: queued per file (a newer write replaces a queued one), a few at a time,
 * retried a few times. `handOff` waits for a user's own write; `settle` for all of them (shutdown, release).
 * Everything fails open: a store that cannot be reached means a moved user re-syncs, as before D992.
 */
import type { Scope } from "@eden/protocol";
import { type DiskOptions, EncryptedFrozenDisk, type FrozenDisk, type PersistedUser } from "./persist";

/** The object store, reduced to what the disk needs. Every method may reject; the disk fails open. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The object's bytes, or null when there is none. */
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix` with its last-modified time (ms), page by page. */
  list(prefix: string): AsyncIterable<{ key: string; modified: number }>;
}

export interface SharedDiskOptions extends DiskOptions {
  store: BlobStore;
  /** Key prefix in the store, e.g. "frozen/". */
  prefix: string;
  /** Store writes in flight at once (default 8). */
  concurrency?: number;
  /** Tries of a store write before it is dropped and counted (default 3). */
  tries?: number;
  /** Users remembered as absent from the store at most (default `MAX_ABSENT`); past it the memory starts over. */
  maxAbsent?: number;
}

/**
 * The most users `absent` holds (R1): one name per user a process ever missed or deleted, cleared otherwise only by a
 * membership change, so a single machine with a store grew it forever. Starting over costs one store read per user.
 */
export const MAX_ABSENT = 100_000;

type Job = { kind: "put"; bytes: Uint8Array } | { kind: "delete" };

const NAME = /^([0-9a-f]{4})-[0-9a-f]{40}\.blob$/;

export class SharedFrozenDisk implements FrozenDisk {
  readonly local: EncryptedFrozenDisk;
  private readonly store: BlobStore;
  private readonly prefix: string;
  private readonly concurrency: number;
  private readonly tries: number;
  private readonly owns: (bucket: number) => boolean;
  private readonly maxAgeMs: number;
  private readonly maxAbsent: number;
  /** The latest job per file name not yet started; a newer one replaces it. */
  private readonly queued = new Map<string, Job>();
  /** Jobs running, per file name, so `handOff` can wait for a user's own. */
  private readonly running = new Map<string, Promise<void>>();
  private active = 0;
  /** Users looked up in the store and not found, since the last membership change (`forgetAbsent`). */
  private readonly absent = new Set<string>();
  private readonly fetching = new Map<string, Promise<void>>();
  /** Per file name with a fetch in flight, the deletes it saw meanwhile: a fetch that saw one is not adopted. */
  private readonly gens = new Map<string, number>();
  private idle: (() => void)[] = [];
  readonly remote = {
    put: 0,
    deleted: 0,
    fetched: 0,
    missed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    bytesPut: 0,
    bytesFetched: 0,
  };

  constructor(options: SharedDiskOptions) {
    const { store, prefix, concurrency, tries, maxAbsent, ...disk } = options;
    this.maxAbsent = maxAbsent ?? MAX_ABSENT;
    this.store = store;
    this.prefix = prefix;
    this.concurrency = concurrency ?? 8;
    this.tries = tries ?? 3;
    this.owns = disk.owns ?? (() => true);
    this.maxAgeMs = disk.maxAgeMs;
    const onWrite = disk.onWrite;
    this.local = new EncryptedFrozenDisk({
      ...disk,
      onWrite: (name, bytes) => {
        onWrite?.(name, bytes);
        this.absent.delete(name);
        this.enqueue(name, { kind: "put", bytes });
      },
    });
  }

  /** Users remembered as absent from the store (bounded by `maxAbsent`). */
  get absentCount(): number {
    return this.absent.size;
  }

  private noteAbsent(name: string): void {
    if (this.absent.size >= this.maxAbsent) this.absent.clear();
    this.absent.add(name);
  }

  /** Blobs in the local directory this process owns. */
  get count(): number {
    return this.local.count;
  }

  has(scope: Scope): boolean {
    return this.local.has(scope);
  }

  read(scope: Scope, now: number): PersistedUser | null {
    return this.local.read(scope, now);
  }

  write(scope: Scope, user: PersistedUser, now: number): boolean {
    return this.local.write(scope, user, now);
  }

  /**
   * Expired, evicted or forgotten: gone here and from the store. A fetch of the user still on the wire is cancelled
   * (its generation moves on): a forget that lands while the store's copy is being read must not bring it back.
   */
  delete(scope: Scope): void {
    const name = this.local.nameOf(scope);
    this.local.delete(scope);
    if (this.fetching.has(name)) this.gens.set(name, (this.gens.get(name) ?? 0) + 1);
    this.noteAbsent(name);
    this.enqueue(name, { kind: "delete" });
  }

  /** A source forgotten or items deleted at their source (review of D992): the store's older copy goes too. */
  invalidate(scope: Scope): void {
    this.delete(scope);
  }

  /** Thawed: the local file goes (D425); the store keeps the failover copy (D992). */
  thawed(scope: Scope): void {
    this.local.delete(scope);
  }

  sweep(now: number): number {
    return this.local.sweep(now);
  }

  fetch(scope: Scope): Promise<void> | null {
    if (this.local.has(scope)) return null;
    const name = this.local.nameOf(scope);
    if (this.absent.has(name)) return null;
    // A write of ours still queued or running is newer than anything the store holds: nothing to fetch.
    if (this.queued.has(name) || this.running.has(name)) return null;
    const known = this.fetching.get(name);
    if (known) return known;
    const gen = this.gens.get(name) ?? 0;
    const p = this.store
      .get(this.prefix + name)
      .then(
        (bytes) => {
          // Deleted (forgotten, expired, invalidated) while the read was on the wire: the bytes are not adopted.
          if ((this.gens.get(name) ?? 0) !== gen) {
            this.remote.cancelled++;
            return;
          }
          if (bytes === null) {
            this.remote.missed++;
            this.noteAbsent(name);
            return;
          }
          this.remote.fetched++;
          this.remote.bytesFetched += bytes.byteLength;
          // Checked like a file found at open; refused (another key, expired) means the user re-syncs.
          if (!this.local.adopt(name, bytes, Date.now())) this.noteAbsent(name);
        },
        () => {
          // Unreachable: not remembered as absent, so the next request tries again.
          this.remote.failed++;
        },
      )
      .finally(() => {
        this.fetching.delete(name);
        this.gens.delete(name);
      });
    this.fetching.set(name, p);
    return p;
  }

  /**
   * The user now belongs to another process (D992): wait for this process's last write of them to reach the store,
   * then drop the local file. The caller wrote them first (`ItemCache.release`).
   */
  async handOff(scope: Scope): Promise<void> {
    const name = this.local.nameOf(scope);
    while (this.queued.has(name) || this.running.has(name)) {
      await (this.running.get(name) ?? this.drained());
    }
    this.local.delete(scope);
    this.absent.delete(name);
  }

  /**
   * Forgets which users the store did not hold (D992): after a membership change another machine may have written
   * them.
   */
  forgetAbsent(): void {
    this.absent.clear();
  }

  /** Waits until every queued store write has run, or `timeoutMs` passes; returns how many are still waiting. */
  async settle(timeoutMs: number): Promise<number> {
    if (this.queued.size + this.active > 0) {
      await Promise.race([this.drained(), Bun.sleep(timeoutMs)]);
    }
    return this.queued.size + this.active;
  }

  /**
   * Deletes store copies past `maxAgeMs` in buckets this process owns (`owns`: in a cluster, of this machine and this
   * child; D428's 7-day bound; a copy whose items expired sooner is refused when read, and goes then). Returns how many
   * went. Daily is enough: the bucket's lifecycle rule
   * is the backstop.
   */
  async sweepStore(now: number, owns: (bucket: number) => boolean = this.owns): Promise<number> {
    let n = 0;
    try {
      for await (const { key, modified } of this.store.list(this.prefix)) {
        const m = NAME.exec(key.slice(this.prefix.length));
        if (!m || !owns(parseInt(m[1]!, 16))) continue;
        if (now - modified <= this.maxAgeMs) continue;
        const name = key.slice(this.prefix.length);
        if (this.queued.has(name)) continue; // a write of ours is on its way
        this.enqueue(name, { kind: "delete" });
        n++;
      }
    } catch {
      this.remote.failed++;
    }
    return n;
  }

  /**
   * R1b (D1071): reads up to `sample` blobs from the store and says how many another key wrote. A store that cannot
   * be listed or read counts as empty (fail open: the server starts). Deletes nothing.
   */
  async checkStoreKey(sample: number): Promise<{ sampled: number; foreign: number }> {
    let sampled = 0;
    let foreign = 0;
    try {
      for await (const { key } of this.store.list(this.prefix)) {
        if (sampled >= sample) break;
        if (!NAME.test(key.slice(this.prefix.length))) continue;
        const bytes = await this.store.get(key);
        const k = bytes === null ? null : this.local.keyOf(bytes);
        if (k === null) continue;
        sampled++;
        if (k === "key") foreign++;
      }
    } catch {
      return { sampled: 0, foreign: 0 };
    }
    return { sampled, foreign };
  }

  /** Store writes waiting or running. */
  get backlog(): number {
    return this.queued.size + this.active;
  }

  /**
   * Which buckets this process may write to the store (D992, review): in a cluster, its own machine's as the last
   * membership said. A process that lost a bucket (a failover it was not told of in time, a request still running at
   * a release) must neither overwrite nor delete the copy its new owner relies on. Default: every bucket.
   */
  setWritable(writable: (bucket: number) => boolean): void {
    this.writable = writable;
  }

  private writable: (bucket: number) => boolean = () => true;

  private enqueue(name: string, job: Job): void {
    const m = NAME.exec(name);
    if (m && !this.writable(parseInt(m[1]!, 16))) {
      // Fenced (R1): a job of ours still queued for the name goes too. Kept, a late put would land after the new
      // owner's delete of a forgotten user and bring them back in the store.
      if (this.queued.delete(name)) this.remote.cancelled++;
      this.remote.skipped++;
      this.pump();
      return;
    }
    this.queued.set(name, job);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queued.size > 0) {
      const [name, job] = this.queued.entries().next().value as [string, Job];
      // Never two jobs on one name at once: a later one waits for the running one, so the last write wins.
      if (this.running.has(name)) {
        const first = this.firstStartable();
        if (first === null) return;
        this.start(first[0], first[1]);
        continue;
      }
      this.start(name, job);
    }
    if (this.active === 0 && this.queued.size === 0) {
      const waiting = this.idle;
      this.idle = [];
      for (const w of waiting) w();
    }
  }

  private firstStartable(): [string, Job] | null {
    for (const [name, job] of this.queued) if (!this.running.has(name)) return [name, job];
    return null;
  }

  private start(name: string, job: Job): void {
    this.queued.delete(name);
    this.active++;
    const run = async () => {
      const m = NAME.exec(name);
      for (let attempt = 1; ; attempt++) {
        // Fenced before it ran or while waiting to retry (R1): the bucket's new owner decides what the store holds
        // now. A write queued behind a release past its deadline would overwrite the new owner's newer copy.
        if (m && !this.writable(parseInt(m[1]!, 16))) {
          this.remote.skipped++;
          return;
        }
        try {
          if (job.kind === "put") {
            await this.store.put(this.prefix + name, job.bytes);
            this.remote.put++;
            this.remote.bytesPut += job.bytes.byteLength;
          } else {
            await this.store.delete(this.prefix + name);
            this.remote.deleted++;
          }
          return;
        } catch {
          if (attempt >= this.tries) {
            this.remote.failed++;
            return;
          }
          await Bun.sleep(100 * 2 ** attempt);
        }
      }
    };
    const p = run().finally(() => {
      this.active--;
      if (this.running.get(name) === p) this.running.delete(name);
      this.pump();
    });
    this.running.set(name, p);
  }

  private drained(): Promise<void> {
    if (this.active === 0 && this.queued.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }
}
