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
import type { Scope } from "@eden/protocol";

/**
 * The on-disk format. Bump it whenever what a blob holds changes shape (`FrozenEntry`, `FrozenBody`, `PersistedUser`,
 * the sync's `SyncSnapshot`): a blob of another version is discarded, never read as this one.
 */
// 2: the header's expiry (1 had none: such files are discarded as "version"). 3: the sync snapshot's `rare`
// (`RareTerms`, D603): a user saved without it would wait for each source's next listing to fill the table.
export const PERSIST_FORMAT = 3;

const MAGIC = Buffer.from("EDNF", "latin1");
const HEADER = 44;
const NONCE = 12;
const TAG = 16;
const NAME = /^[0-9a-f]{40}\.blob$/;
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
      // read back by the next process (the review of D652, where every thaw reads).
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
      writeFileSync(tmp, Buffer.concat([header, ...body]), { mode: 0o600 });
      renameSync(tmp, path);
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

  /** The user's file name: a keyed hash, so the directory names no tenant or user (ids hold no NUL: `isId`). */
  nameOf(scope: Scope): string {
    const h = createHmac("sha256", this.names).update(`${scope.tenantId}\0${scope.userId}`, "utf8").digest("hex");
    return `${h.slice(0, 40)}.blob`;
  }

  /** Reads every blob's header: temporary files, other versions, other keys and expired blobs are deleted. */
  private open(now: number): void {
    for (const name of readdirSync(this.o.dir)) {
      const path = join(this.o.dir, name);
      if (name.endsWith(TMP)) {
        rmSync(path, { force: true });
        continue;
      }
      if (!NAME.test(name)) continue; // Not ours: left alone.
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
  }

  private headerProblem(file: Buffer, now: number): "version" | "key" | "expired" | "corrupt" | null {
    if (file.length < HEADER || !file.subarray(0, 4).equals(MAGIC)) return "corrupt";
    if (file.readUInt16LE(4) !== PERSIST_FORMAT) return "version";
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
