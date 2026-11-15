/**
 * Frozen users on disk, encrypted (D425, opt-in; off by default, where D8 stands unchanged). A user frozen while idle
 * (D325) is one compressed blob in memory; with a `FrozenDisk` the cache also writes that blob here, so a restarted
 * process thaws its users from disk on their first use instead of listing every source again.
 *
 * One file per user, named by a keyed hash of tenant and user (`nameOf`: the directory reveals no id), holding:
 *
 *   header (44 bytes, in the clear, authenticated): "EDNF", format version (u16), 0 (u16), key id (8 bytes),
 *     time written (f64, ms), expiry (f64, ms: the latest any item or probe in it lives to), nonce (12 bytes,
 *     random per write)
 *   AES-256-GCM ciphertext of: meta length (u32) | meta JSON | the zstd blob; then its 16-byte tag
 *
 * The additional data is the header and the tenant and user ids, so a file copied under another user's name, or
 * written for another user, fails to open (and so does one whose time, expiry or version was edited). Keys come from
 * the operator's 32-byte key by HKDF (one for encryption, one for names, one for the key id); the key is never logged.
 *
 * Everything fails open: a file of another format version, another key, past its expiry or `maxAgeMs` (whichever comes
 * first), or that does not decrypt is
 * deleted and reported by reason only (`PersistEvent`), and the user simply re-syncs. A write that would take the
 * directory past `maxBytes` is not made (reported "full"). Sync I/O, a user at a time: a few milliseconds at the sync
 * cap (docs/research/c3-persist-frozen.md), inside the cache's sliced freeze or a thaw that reads the user anyway.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bucketOf, type Scope } from "@eden/protocol";

/**
 * The on-disk format. Bump it whenever what a blob holds changes shape (`FrozenEntry`, `FrozenBody`, `PersistedUser`,
 * the sync's `SyncSnapshot`): a blob of another version is discarded, never read as this one.
 */
// 2: the header's expiry (1 had none: such files are discarded as "version"). 3: the sync snapshot's `rare`
// (`RareTerms`, D603): a user saved without it would wait for each source's next listing to fill the table.
// 4: a blob may be a warm one (D860, D862: "EDF2", its text bytes deflated and its index as arrays); a build before
// it would not read one, and discards it as another version. Files of 3 are still read (`READABLE_FORMATS`).
// 5 (D992): the owner's extra carries the user's source-map rows (learning that moves with them between processes and
// machines), and file names start with the user's bucket; files of 3 and 4 had other names and are not met again.
// 6 (D1888): an entry may carry its date facts (`FrozenEntry.t`, `FastEntry.t`); a build before it would ignore them,
// and discards the file as another version all the same. Files of 5 are still read: their entries have none, and
// read them from the text at the first scan, as before.
// 7 (D1926): a warm blob's packed texts may be zstd frames (`FastEntry.p`'s tag, bit 1); a build before it would read
// them as DEFLATE and fail. Files of 6 are still read: their texts are DEFLATE, tags 0 and 1, read as before.
export const PERSIST_FORMAT = 7;
/** Formats a file may have and still be read: 3's blobs are compact ones, which this build still reads (D862). */
export const READABLE_FORMATS: ReadonlySet<number> = new Set([3, 4, 5, 6, PERSIST_FORMAT]);

const MAGIC = Buffer.from("EDNF", "latin1");
const HEADER = 44;
const NONCE = 12;
const TAG = 16;
/** `<bucket, 4 hex>-<keyed hash, 40 hex>.blob` (D992): the bucket in the clear, so ownership needs no key. */
const NAME = /^([0-9a-f]{4})-[0-9a-f]{40}\.blob$/;
const TMP = ".tmp";

/** What a frozen user carries besides its blob (the cache's `FrozenUser` fields that outlive a process). */
export interface PersistedUser {
  synced: number;
  size: number;
  probes: [string, { ids: string[]; at: number }][];
  oldest: [number, number];
  newest: [number, number];
  /** The largest `Entry.seq` in the blob: the loading cache's sequence counter moves past it. */
  maxSeq: number;
  /** Saved beside the cache's state by its owner (the partner: the sync's per-source state). */
  extra?: unknown;
  /** The cache's zstd JSON blob of entries and tallies (`FrozenBody`). */
  blob: Uint8Array;
  /**
   * When everything in the blob has expired (ms, the cache's clock): the latest of each class's newest item plus its
   * time to live, and of the newest probe plus its own. Written into the authenticated header, never past `maxAgeMs`
   * after the write, so a file nobody reads back is deleted when its newest item expires, not days later.
   */
  expiresAt: number;
}

/** Content-free reports: what went wrong, never whose or what. */
export type PersistEvent =
  | { kind: "discarded"; reason: "version" | "key" | "expired" | "corrupt" }
  | { kind: "write-failed"; reason: "full" | "io" }
  | { kind: "read-failed"; reason: "io" };

/** Where the cache keeps frozen users across a restart (`ItemCache.persist`). */
export interface FrozenDisk {
  /** Whether a blob for the user may be on disk: no I/O. */
  has(scope: Scope): boolean;
  /** The user's blob, or null (none, or discarded and reported). Never throws. */
  read(scope: Scope, now: number): PersistedUser | null;
  /** Writes the user's blob (replacing any); false when not written (reported). Never throws. */
  write(scope: Scope, user: PersistedUser, now: number): boolean;
  /** Deletes the user's blob, if any. Never throws. */
  delete(scope: Scope): void;
  /** Deletes blobs past their expiry or age that nothing has read, without decrypting them; returns how many. */
  sweep(now: number): number;
  /**
   * A store shared with other processes (D992) may hold a user this one has not seen: this makes their blob readable
   * by `has`/`read` (an async fetch), and returns null when there is nothing to wait for. `ItemCache.ready` awaits it
   * before its synchronous read, so a moved user's first request waits for the fetch, never the event loop.
   */
  fetch?(scope: Scope): Promise<void> | null;
  /**
   * Called instead of `delete` when a user is thawed (D425: a live user's state changes, so the local file goes). A
   * shared store keeps its copy (D992): it is what another machine fails over from, the user's last compact freeze.
   */
  thawed?(scope: Scope): void;
  /**
   * The user's state changed in a way an older blob must not outlive (a source forgotten, items deleted at their
   * source): a shared store's copy goes (D992, review). A local store holds no file of a live user, so it has nothing
   * to do.
   */
  invalidate?(scope: Scope): void;
}

export interface DiskOptions {
  dir: string;
  /** The operator's key, 32 bytes. */
  key: Uint8Array;
  /** Bytes the directory may hold (the blobs this store knows of). */
  maxBytes: number;
  /** A blob written longer ago than this is discarded: every item in it would have expired (the longest TTL). */
  maxAgeMs: number;
  report?: (e: PersistEvent) => void;
  /**
   * Whether this process owns a bucket (D992): only owned files are indexed, swept or cleaned up at open, so processes
   * sharing one directory (a machine's children) each see their own users'. Default: every bucket.
   */
  owns?: (bucket: number) => boolean;
  /** Called with each file's name and bytes once written (D992: a shared store mirrors them). */
  onWrite?: (name: string, bytes: Uint8Array) => void;
  /**
   * Deletes the owned files found at open instead of reading them (D992: in a cluster the store is the copy of
   * record, and a local file left from before a restart may be older than what another machine wrote since).
   */
  startEmpty?: boolean;
  /**
   * R1b (D1071): when the directory holds blobs of this store's own buckets and the key opens none of them, the open
   * throws `PersistKeyMismatch` and deletes none of the foreign ones (temporary, corrupt and other-version files go):
   * a mistyped key on an upgrade would otherwise wipe every persisted user. A directory where some blob opens is a
   * key that works: the foreign ones are discarded, as when this is off (the default here; the servers turn it on
   * unless the operator asks to discard).
   */
  refuseForeignKey?: boolean;
}

/** The key opens none of the blobs on disk (`DiskOptions.refuseForeignKey`): no foreign blob was deleted. */
export class PersistKeyMismatch extends Error {
  constructor(
    readonly foreign: number,
    readonly dir: string,
  ) {
    super(`the persistence key opens none of the ${foreign} persisted users in ${dir}`);
    this.name = "PersistKeyMismatch";
  }
}

/** The AES-256-GCM store (D425). Opening it reads every file's header once and deletes what it cannot use. */
export class EncryptedFrozenDisk implements FrozenDisk {
  private readonly enc: Buffer;
  private readonly names: Buffer;
  private readonly keyId: Buffer;
  /** Blobs on disk this store knows of: file name → bytes, time written and how long it lives (`lifetime`). */
  private readonly files = new Map<string, { bytes: number; at: number; life: number }>();
  private bytes = 0;
  /** Counts, and the time spent writing (encrypt + write + rename) and reading (read + decrypt), for the benches. */
  readonly stats = {
    written: 0,
    read: 0,
    deleted: 0,
    discarded: 0,
    writeFailed: 0,
    bytesWritten: 0,
    writeMs: 0,
    readMs: 0,
  };

  /** The options without the operator's key: only the derived keys are kept, so no dump of the store shows it. */
  private readonly o: Omit<DiskOptions, "key">;

  constructor(options: DiskOptions) {
    const { key, ...o } = options;
    this.o = o;
    if (key.byteLength !== 32) throw new Error("the persistence key must be 32 bytes");
    const derive = (info: string, n: number) => Buffer.from(hkdfSync("sha256", key, "eden-persist-frozen", info, n));
    this.enc = derive("enc", 32);
    this.names = derive("name", 32);
    this.keyId = derive("key-id", 8);
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.open(Date.now());
  }

  /** Bytes of the blobs this store knows of. */
  get size(): number {
    return this.bytes;
  }

  /** Blobs this store knows of. */
  get count(): number {
    return this.files.size;
  }

  has(scope: Scope): boolean {
    return this.files.size > 0 && this.files.has(this.nameOf(scope));
  }

  read(scope: Scope, now: number): PersistedUser | null {
    if (this.files.size === 0) return null;
    const name = this.nameOf(scope);
    const known = this.files.get(name);
    if (!known) return null;
    const t0 = performance.now();
    let file: Buffer;
    try {
      file = readFileSync(join(this.o.dir, name));
    } catch {
      // Unlinked, best effort: a file this store stopped knowing of would outlive a later forget of its user and be
      // read back by the next process (found in the review of D652, a trial since deleted).
      this.remove(name);
      this.o.report?.({ kind: "read-failed", reason: "io" });
      return null;
    }
    const bad = this.headerProblem(file, now);
    if (bad) return this.discard(name, bad);
    try {
      const header = file.subarray(0, HEADER);
      const nonce = file.subarray(HEADER - NONCE, HEADER);
      const d = createDecipheriv("aes-256-gcm", this.enc, nonce);
      d.setAAD(aad(header, scope));
      d.setAuthTag(file.subarray(file.length - TAG));
      const plain = Buffer.concat([d.update(file.subarray(HEADER, file.length - TAG)), d.final()]);
      const metaLength = plain.readUInt32LE(0);
      const meta = JSON.parse(plain.subarray(4, 4 + metaLength).toString("utf8")) as Omit<PersistedUser, "blob">;
      if (!validMeta(meta)) return this.discard(name, "corrupt");
      this.stats.read++;
      this.stats.readMs += performance.now() - t0;
      return { ...meta, blob: new Uint8Array(plain.subarray(4 + metaLength)), expiresAt: file.readDoubleLE(24) };
    } catch {
      // Tampered, truncated, copied from another user's name, or written under another key with the same id.
      return this.discard(name, "corrupt");
    }
  }

  write(scope: Scope, user: PersistedUser, now: number): boolean {
    const name = this.nameOf(scope);
    const t0 = performance.now();
    try {
      const { blob, expiresAt, ...meta } = user;
      const json = Buffer.from(JSON.stringify(meta), "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(json.length, 0);
      const size = HEADER + 4 + json.length + blob.byteLength + TAG;
      const old = this.files.get(name)?.bytes ?? 0;
      if (this.bytes - old + size > this.o.maxBytes) {
        // Not written; an older blob of the user's must not outlive the state it no longer matches.
        this.delete(scope);
        this.stats.writeFailed++;
        this.o.report?.({ kind: "write-failed", reason: "full" });
        return false;
      }
      const header = Buffer.alloc(HEADER);
      MAGIC.copy(header, 0);
      header.writeUInt16LE(PERSIST_FORMAT, 4);
      this.keyId.copy(header, 8);
      header.writeDoubleLE(now, 16);
      // Never later than the age cap; an unknown expiry (no item, no probe: NaN) is now, so the file goes at once.
      const until = Number.isFinite(expiresAt) ? Math.min(expiresAt, now + this.o.maxAgeMs) : now;
      header.writeDoubleLE(until, 24);
      randomBytes(NONCE).copy(header, HEADER - NONCE);
      const c = createCipheriv("aes-256-gcm", this.enc, header.subarray(HEADER - NONCE));
      c.setAAD(aad(header, scope));
      const body = [c.update(length), c.update(json), c.update(blob), c.final(), c.getAuthTag()];
      const path = join(this.o.dir, name);
      const tmp = `${path}${TMP}`;
      // A whole file or none: a crash mid-write leaves a temporary file, deleted at the next open.
      const file = Buffer.concat([header, ...body]);
      writeFileSync(tmp, file, { mode: 0o600 });
      renameSync(tmp, path);
      this.o.onWrite?.(name, file);
      this.bytes += size - old;
      this.files.set(name, { bytes: size, at: now, life: lifetime(now, until, this.o.maxAgeMs) });
      this.stats.written++;
      this.stats.bytesWritten += size;
      this.stats.writeMs += performance.now() - t0;
      return true;
    } catch {
      this.delete(scope);
      this.stats.writeFailed++;
      this.o.report?.({ kind: "write-failed", reason: "io" });
      return false;
    }
  }

  delete(scope: Scope): void {
    if (this.files.size === 0) return;
    const name = this.nameOf(scope);
    if (!this.files.has(name)) return;
    this.remove(name);
    this.stats.deleted++;
  }

  sweep(now: number): number {
    let n = 0;
    for (const [name, f] of this.files) {
      if (!expired(f.at, f.life, now)) continue;
      this.remove(name);
      this.stats.discarded++;
      this.o.report?.({ kind: "discarded", reason: "expired" });
      n++;
    }
    return n;
  }

  /**
   * The user's file name: the bucket (D992), then a keyed hash, so the directory names no tenant or user (ids hold no
   * NUL: `isId`).
   */
  nameOf(scope: Scope): string {
    const h = createHmac("sha256", this.names).update(`${scope.tenantId}\0${scope.userId}`, "utf8").digest("hex");
    return `${bucketOf(scope.tenantId, scope.userId).toString(16).padStart(4, "0")}-${h.slice(0, 40)}.blob`;
  }

  /**
   * Takes a file another process wrote (D992: fetched from a shared store) as this store's own: checked like a file
   * found at open (name, header, key id, expiry), written whole or not at all. False when refused (reported).
   */
  adopt(name: string, bytes: Uint8Array, now: number): boolean {
    const m = NAME.exec(name);
    if (!m || !this.ownsBucket(parseInt(m[1]!, 16))) return false;
    const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bad = file.length < HEADER + 4 + TAG ? "corrupt" : this.headerProblem(file, now);
    if (bad) {
      this.stats.discarded++;
      this.o.report?.({ kind: "discarded", reason: bad });
      return false;
    }
    const old = this.files.get(name)?.bytes ?? 0;
    if (this.bytes - old + file.length > this.o.maxBytes) {
      this.stats.writeFailed++;
      this.o.report?.({ kind: "write-failed", reason: "full" });
      return false;
    }
    try {
      const path = join(this.o.dir, name);
      writeFileSync(`${path}${TMP}`, file, { mode: 0o600 });
      renameSync(`${path}${TMP}`, path);
    } catch {
      this.stats.writeFailed++;
      this.o.report?.({ kind: "write-failed", reason: "io" });
      return false;
    }
    const at = file.readDoubleLE(16);
    this.bytes += file.length - old;
    this.files.set(name, { bytes: file.length, at, life: lifetime(at, file.readDoubleLE(24), this.o.maxAgeMs) });
    return true;
  }

  /** Deletes the local files whose bucket `keep` rejects (D992: a fenced node drops what it no longer owns). */
  dropWhere(keep: (bucket: number) => boolean): number {
    let n = 0;
    for (const name of [...this.files.keys()]) {
      const m = NAME.exec(name);
      if (!m || keep(parseInt(m[1]!, 16))) continue;
      this.remove(name);
      n++;
    }
    return n;
  }

  private ownsBucket(bucket: number): boolean {
    return this.o.owns ? this.o.owns(bucket) : true;
  }

  /** Reads every blob's header: temporary files, other versions, other keys and expired blobs are deleted. */
  private open(now: number): void {
    // Blobs another key wrote: deleted after the loop, unless no blob opens and the store refuses (D1071).
    const foreign: string[] = [];
    // Blobs this key wrote, expired ones too: one is enough to show the key is the right one (review of R1b).
    let own = 0;
    for (const name of readdirSync(this.o.dir)) {
      const path = join(this.o.dir, name);
      // Another process's files in a shared directory (D992) are left alone, a half-written one included.
      const m = NAME.exec(name.endsWith(TMP) ? name.slice(0, -TMP.length) : name);
      if (!m) continue; // Not ours: left alone.
      if (!this.ownsBucket(parseInt(m[1]!, 16))) continue;
      if (name.endsWith(TMP) || this.o.startEmpty) {
        rmSync(path, { force: true });
        continue;
      }
      let head: Buffer;
      let bytes: number;
      try {
        bytes = statSync(path).size;
        head = Buffer.alloc(HEADER);
        const fd = openSync(path, "r");
        try {
          readSync(fd, head, 0, HEADER, 0);
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const bad = bytes < HEADER + 4 + TAG ? "corrupt" : this.headerProblem(head, now);
      if (bad === "key") {
        foreign.push(path);
        continue;
      }
      // `headerProblem` checks the key before the expiry: an expired blob was written with this key.
      if (bad === "expired" || bad === null) own++;
      if (bad) {
        rmSync(path, { force: true });
        this.stats.discarded++;
        this.o.report?.({ kind: "discarded", reason: bad });
        continue;
      }
      const at = head.readDoubleLE(16);
      this.files.set(name, { bytes, at, life: lifetime(at, head.readDoubleLE(24), this.o.maxAgeMs) });
      this.bytes += bytes;
    }
    if (foreign.length > 0 && own === 0 && this.o.refuseForeignKey) {
      throw new PersistKeyMismatch(foreign.length, this.o.dir);
    }
    for (const path of foreign) {
      rmSync(path, { force: true });
      this.stats.discarded++;
      this.o.report?.({ kind: "discarded", reason: "key" });
    }
  }

  /** The key's id as blob headers carry it (8 bytes derived from the key, not the key): the store's marker (D1071). */
  get keyMark(): Uint8Array {
    return new Uint8Array(this.keyId);
  }

  /**
   * Whether this store's key wrote a blob (R1b, `SharedFrozenDisk.checkStoreKey`): "ok", "key" (another key wrote
   * it), or null when the bytes are not a blob of a version this store reads. Reads the header only.
   */
  keyOf(bytes: Uint8Array): "ok" | "key" | null {
    const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (file.length < HEADER + 4 + TAG || !file.subarray(0, 4).equals(MAGIC)) return null;
    if (!READABLE_FORMATS.has(file.readUInt16LE(4))) return null;
    return file.subarray(8, 16).equals(this.keyId) ? "ok" : "key";
  }

  private headerProblem(file: Buffer, now: number): "version" | "key" | "expired" | "corrupt" | null {
    if (file.length < HEADER || !file.subarray(0, 4).equals(MAGIC)) return "corrupt";
    if (!READABLE_FORMATS.has(file.readUInt16LE(4))) return "version";
    if (!file.subarray(8, 16).equals(this.keyId)) return "key";
    const at = file.readDoubleLE(16);
    const until = file.readDoubleLE(24);
    if (!Number.isFinite(at) || !Number.isFinite(until)) return "expired";
    // Read before the tag is checked: `lifetime` caps it at the age limit, so an edited expiry never keeps a file
    // longer than that (and the edit fails to decrypt anyway).
    if (expired(at, lifetime(at, until, this.o.maxAgeMs), now)) return "expired";
    return null;
  }

  private discard(name: string, reason: "version" | "key" | "expired" | "corrupt"): null {
    this.remove(name);
    this.stats.discarded++;
    this.o.report?.({ kind: "discarded", reason });
    return null;
  }

  private remove(name: string): void {
    try {
      unlinkSync(join(this.o.dir, name));
    } catch {
      // Gone already: what matters is that this store no longer reads it.
    }
    this.forgetFile(name);
  }

  private forgetFile(name: string): void {
    const f = this.files.get(name);
    if (!f) return;
    this.bytes -= f.bytes;
    this.files.delete(name);
  }
}

/** How long a file lives after it was written: to its expiry, never past the age cap. */
function lifetime(at: number, until: number, maxAgeMs: number): number {
  return Number.isFinite(at) && Number.isFinite(until) ? Math.min(until - at, maxAgeMs) : -1;
}

/**
 * Whether a file written at `at` that lives `life` ms is past it. A time ahead of this clock is read as written now (a
 * clock moved back), never as fresher than it is.
 */
function expired(at: number, life: number, now: number): boolean {
  return !Number.isFinite(at) || now - Math.min(at, now) > life;
}

/** The additional data: the header (version, key id, time, expiry, nonce) and whose blob it is. */
function aad(header: Buffer, scope: Scope): Buffer {
  return Buffer.concat([header, Buffer.from(`${scope.tenantId}\0${scope.userId}`, "utf8")]);
}

function validMeta(m: unknown): m is Omit<PersistedUser, "blob"> {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  return (
    typeof x.synced === "number" &&
    typeof x.size === "number" &&
    typeof x.maxSeq === "number" &&
    Array.isArray(x.probes) &&
    Array.isArray(x.oldest) &&
    Array.isArray(x.newest)
  );
}
