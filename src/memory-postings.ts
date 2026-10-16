/**
 * The postings snapshot and the bounded candidate set (P4.2; A4 §5.1 step 4c, A7 §8, A2 §2.2, D17).
 *
 * A Submit is a fresh process. Tokenizing every row to index it costs about 100–180 ms at 20k rows (A7 §8, R1 §4),
 * so sleep writes the index once, `postings.snap` beside the store, and a Submit reads only what its cue's terms
 * need. The file is one atomic write (a reader that opened it keeps reading that version), in three parts:
 *
 * - a header line (JSON): the snapshot's own id, the rows indexed by scope with their field lengths (BM25F's N and mean
 *   lengths, `memory-bm25f.ts`), and the byte range of each part below;
 * - the ids of the indexed rows, one per line, oldest first, each with a digest of what its terms are read from: a
 *   row's place in this list is its ordinal;
 * - buckets: a term's postings, by scope, as ordinals, ascending (so newest last). A term lives in the bucket its hash
 *   names, so a cue of ten words reads ten small buckets, never the whole index.
 *
 * Postings are scoped (03-BUILD, A2 §2.2: "filter by scope first"): a reader reads the lists of the scopes it may see
 * (`RowFilter.scopes`), so a term busy in a sibling folder costs it nothing. Rows the snapshot does not hold by id,
 * the delta, are indexed in process: rows written since, and rows another process wrote that its builder had not yet
 * read. A row the snapshot holds is always scored from its current text, but found only by the terms it had at the
 * build: one whose text, tags or keys changed since (sleep's alias passes, a rewrite) waits for the next snapshot as
 * a new row does (`rowDigest`). The light sleep refreshes the snapshot once `SNAPSHOT_DELTA` rows wait, the idle
 * sleeper whenever one does, and either whenever a part of it cannot be read.
 *
 * The candidate set (`candidateRows`) is bounded, |C| ≤ 200, and never walks a whole fat list in recency or score
 * order: a term in at most `FAT_DF` visible rows gives them all, rarest term first; of the fatter ones, the rarest 4
 * give the rows two of them share (A2: "intersect with the next-rarer term"), then each gives its newest 64.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryRecord } from "./index";
import { FIELDS, rowTerms, type Corpus, type Field, type RowFields } from "./memory-bm25f";

export const SNAPSHOT_FILE = "postings.snap";
const SNAPSHOT_VERSION = 1;
/** |C| ≤ 200 (D17). */
export const CANDIDATE_CAP = 200;
/** A fat term: in more visible rows than this; it is read newest-64 (D17). */
export const FAT_DF = 64;
/** How many entries of one fat list an intersection reads at most, so a list of any length costs a bounded time. */
const SCAN_CAP = 8_192;
/** How many entries a newest-64 read walks at most (03-BUILD's walk cap: "64 ids, 256 posting entries"). */
const NEWEST_WALK = 256;
/** The fat terms whose rows are intersected: the rarest few (03-BUILD: "union up to a small number of rare lists"). */
const INTERSECTED = 4;
/** The light sleep refreshes the snapshot once this many rows wait outside it (a Submit indexes them in process). */
export const SNAPSHOT_DELTA = 256;
/** The scope key of a row stored with no scope: every reader sees it (`visibleFrom`). */
const NO_SCOPE = "\u0000";

/** A row as the index reads it: the row and its fields. */
export interface Indexed {
  rec: MemoryRecord;
  readonly fields: RowFields;
}

/** Which rows a reader may see, and, when it can tell, which scopes may hold one (`visibleFrom`). */
export type RowFilter = ((row: MemoryRecord) => boolean) & { scopes?: (scope: string) => boolean };

interface ScopeStats {
  n: number;
  len: Record<Field, number>;
}

interface Header {
  v: number;
  /** This snapshot's own id: a reader's delta index is kept for one snapshot only. */
  id: string;
  rows: number;
  ids: [number, number];
  buckets: [number, number][];
  scopes: Record<string, ScopeStats>;
}

/** A term's postings in one bucket: ordinals by scope key. */
type Bucket = Record<string, Record<string, number[]>>;

/** A record keyed by terms or folder names: no inherited key ("constructor") can shadow one. */
function record<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}

/** An own entry of a parsed record (`JSON.parse` gives `Object.prototype`'s keys too). */
function own<V>(from: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(from, key) ? from[key] : undefined;
}

function scopeKey(rec: Pick<MemoryRecord, "scope">): string {
  return typeof rec.scope === "string" ? rec.scope : NO_SCOPE;
}

/** FNV-1a over a string. */
function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** The bucket a term lives in. */
function bucketOf(term: string, buckets: number): number {
  return fnv(term) % buckets;
}

/** A digest of what a row's terms are read from (`rowFields`) and where it is posted: its text, tags, keys, place. */
export function rowDigest(rec: Pick<MemoryRecord, "text" | "tags" | "slots" | "scope" | "cite">): string {
  const keys = JSON.stringify(rec.slots ?? []);
  return fnv(
    `${rec.text}\0${(rec.tags ?? []).join(" ")}\0${keys}\0${scopeKey(rec)}\0${(rec.cite ?? []).join(" ")}`,
  ).toString(36);
}

/** Enough buckets that one holds about 2,000 postings. */
function bucketCount(postings: number): number {
  let count = 16;
  while (count < 4_096 && postings / count > 2_000) count *= 2;
  return count;
}

/**
 * The snapshot's bytes for rows given oldest first. The caller chooses them (`AgentMemory.refreshPostings`): live
 * rankable rows, no rule row (a policy is delivered by its classes, never by word overlap, D18).
 */
export function snapshotBytes(rows: readonly Indexed[]): Buffer {
  const scopes = record<ScopeStats>();
  const terms = new Map<string, Record<string, number[]>>();
  let postings = 0;
  rows.forEach(({ rec, fields }, ordinal) => {
    const key = scopeKey(rec);
    const stats = (scopes[key] ??= { n: 0, len: { value: 0, subject: 0, alias: 0, body: 0 } });
    stats.n++;
    for (const field of FIELDS) stats.len[field] += fields[field].length;
    for (const term of rowTerms(fields)) {
      let byScope = terms.get(term);
      if (!byScope) terms.set(term, (byScope = record<number[]>()));
      (byScope[key] ??= []).push(ordinal);
      postings++;
    }
  });
  const count = bucketCount(postings);
  const buckets = Array.from({ length: count }, () => record<Record<string, number[]>>());
  for (const [term, byScope] of terms) buckets[bucketOf(term, count)]![term] = byScope;
  const ids = rows.map(({ rec }) => `${rec.id}\t${rowDigest(rec)}`).join("\n");
  const parts = [ids, ...buckets.map((bucket) => JSON.stringify(bucket))];
  const bodies = parts.map((part) => Buffer.from(part, "utf8"));
  const ranges: [number, number][] = [];
  let at = 0;
  for (const body of bodies) {
    ranges.push([at, body.length]);
    at += body.length;
  }
  const header: Header = {
    v: SNAPSHOT_VERSION,
    id: `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`,
    rows: rows.length,
    ids: ranges[0]!,
    buckets: ranges.slice(1),
    scopes,
  };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), ...bodies]);
}

/** Writes the snapshot atomically (a reader keeps the version it opened). */
export function writeSnapshot(dir: string, rows: readonly Indexed[]): void {
  const path = join(dir, SNAPSHOT_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, snapshotBytes(rows), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** One open snapshot, read part by part through one file descriptor (one version, whatever is written meanwhile). */
export class Snapshot {
  private readonly buckets = new Map<number, Bucket>();
  private held?: { ids: string[]; digests: string[] };

  private constructor(
    private readonly fd: number,
    readonly header: Header,
    private readonly base: number,
  ) {}

  /** The snapshot of a store directory; undefined when there is none or it cannot be read. */
  static open(dir: string): Snapshot | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, SNAPSHOT_FILE), "r");
      const { line, bytes } = firstLine(fd);
      const header = JSON.parse(line) as Header;
      if (header?.v !== SNAPSHOT_VERSION || !Array.isArray(header.buckets) || !header.buckets.length) throw 0;
      return new Snapshot(fd, header, bytes);
    } catch {
      if (fd !== undefined) closeSync(fd);
      return undefined;
    }
  }

  /** The indexed rows' ids by ordinal. */
  ids(): string[] {
    return this.rows().ids;
  }

  /** Each indexed row's digest at the build (`rowDigest`), by id. */
  digests(): Map<string, string> {
    const { ids, digests } = this.rows();
    return new Map(ids.map((id, at) => [id, digests[at]!]));
  }

  /** Reads every bucket: throws when one cannot be read, as a reader would at that term. */
  verify(): void {
    for (let at = 0; at < this.header.buckets.length; at++) this.bucket(at);
  }

  /** A term's ordinals by scope key, ascending; undefined when no indexed row holds it. */
  lists(term: string): Record<string, number[]> | undefined {
    return own(this.bucket(bucketOf(term, this.header.buckets.length)), term);
  }

  private bucket(at: number): Bucket {
    let bucket = this.buckets.get(at);
    if (!bucket) this.buckets.set(at, (bucket = JSON.parse(this.read(this.header.buckets[at]!)) as Bucket));
    return bucket;
  }

  private rows(): { ids: string[]; digests: string[] } {
    if (this.held) return this.held;
    const lines = this.header.rows ? this.read(this.header.ids).split("\n") : [];
    const ids: string[] = [];
    const digests: string[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      ids.push(tab < 0 ? line : line.slice(0, tab));
      digests.push(tab < 0 ? "" : line.slice(tab + 1));
    }
    return (this.held = { ids, digests });
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {}
  }

  private read([offset, length]: [number, number]): string {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const got = readSync(this.fd, buf, done, length - done, this.base + offset + done);
      if (!got) throw new Error("postings snapshot truncated");
      done += got;
    }
    return buf.toString("utf8");
  }
}

/** The header line of an open file and the bytes it takes with its newline. */
function firstLine(fd: number): { line: string; bytes: number } {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const buf = Buffer.alloc(65_536);
    const got = readSync(fd, buf, 0, buf.length, position);
    if (!got) throw new Error("postings snapshot has no header");
    const end = buf.subarray(0, got).indexOf(0x0a);
    if (end >= 0) {
      chunks.push(buf.subarray(0, end));
      const line = Buffer.concat(chunks);
      return { line: line.toString("utf8"), bytes: line.length + 1 };
    }
    chunks.push(buf.subarray(0, got));
    position += got;
  }
}

/** A term's visible rows, newest first, and how many there are (its df for the reader). */
interface TermRows<T> {
  term: string;
  df: number;
  newest(): Iterable<T>;
}

/**
 * The rows the snapshot does not hold, indexed in process. A long-lived process keeps it until its rows change
 * (`AgentMemory`), so a request does not index them again.
 */
export class DeltaIndex<T extends Indexed> {
  private readonly byTerm = new Map<string, T[]>();

  constructor(
    /** The id of the snapshot it complements, none without a snapshot: then every row is the delta. */
    readonly snapshot: string | undefined,
    readonly rows: readonly T[],
  ) {
    for (const row of rows)
      for (const term of rowTerms(row.fields)) {
        const list = this.byTerm.get(term);
        if (list) list.push(row);
        else this.byTerm.set(term, [row]);
      }
  }

  /** A term's delta rows, in store order (oldest first). */
  rowsOf(term: string): readonly T[] {
    return this.byTerm.get(term) ?? [];
  }
}

/**
 * The index as one reader sees it: the snapshot's lists of the scopes it may see, and the delta's rows there. Built
 * per retrieval; it resolves an ordinal to a row of the store as loaded (`byId`), skipping rows that left.
 */
export class PostingsView<T extends Indexed> implements Corpus {
  readonly n: number;
  readonly avg: Readonly<Record<Field, number>>;
  private readonly scopes: string[];
  private readonly lists = new Map<string, TermRows<T>>();

  constructor(
    private readonly snapshot: Snapshot | undefined,
    private readonly delta: DeltaIndex<T>,
    private readonly byId: (id: string) => T | undefined,
    private readonly sees: (scope: string) => boolean,
  ) {
    const stats = snapshot?.header.scopes ?? {};
    this.scopes = Object.keys(stats).filter((key) => key === NO_SCOPE || sees(key));
    let n = 0;
    const len: Record<Field, number> = { value: 0, subject: 0, alias: 0, body: 0 };
    for (const key of this.scopes) {
      n += stats[key]!.n;
      for (const field of FIELDS) len[field] += stats[key]!.len[field];
    }
    for (const row of delta.rows) {
      if (!this.seen(row)) continue;
      n++;
      for (const field of FIELDS) len[field] += row.fields[field].length;
    }
    this.n = n;
    this.avg = Object.fromEntries(FIELDS.map((field) => [field, n ? len[field] / n : 0])) as Record<Field, number>;
  }

  df(term: string): number {
    return this.rowsOf(term).df;
  }

  /** A term's visible rows (`TermRows`): the delta's, newest first, then the snapshot's scopes merged, newest first. */
  rowsOf(term: string): TermRows<T> {
    const known = this.lists.get(term);
    if (known) return known;
    const own = this.delta.rowsOf(term).filter((row) => this.seen(row));
    const lists = this.snapshotLists(term);
    const df = own.length + lists.reduce((sum, list) => sum + list.length, 0);
    const ids = lists.length ? this.snapshot!.ids() : [];
    const byId = this.byId;
    const rows: TermRows<T> = {
      term,
      df,
      *newest() {
        for (let i = own.length - 1; i >= 0; i--) yield own[i]!;
        for (const ordinal of newestFirst(lists)) {
          const row = byId(ids[ordinal]!);
          if (row) yield row;
        }
      },
    };
    this.lists.set(term, rows);
    return rows;
  }

  /** Whether a delta row is at a scope the reader may see (a row with no scope is every reader's). */
  private seen(row: T): boolean {
    const key = scopeKey(row.rec);
    return key === NO_SCOPE || this.sees(key);
  }

  private snapshotLists(term: string): number[][] {
    if (!this.snapshot) return [];
    const byScope = this.snapshot.lists(term);
    if (!byScope) return [];
    return this.scopes.map((key) => own(byScope, key)).filter((list): list is number[] => !!list?.length);
  }
}

/** Ascending ordinal lists merged, newest (highest) first. */
function* newestFirst(lists: readonly number[][]): Generator<number> {
  const at = lists.map((list) => list.length - 1);
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++)
      if (at[i]! >= 0 && (best < 0 || lists[i]![at[i]!]! > lists[best]![at[best]!]!)) best = i;
    if (best < 0) return;
    yield lists[best]![at[best]!--]!;
  }
}

/**
 * The bounded candidate set (see the header) for a cue's terms. `accept` is the reader's filter (visible, live,
 * rankable); rows it refuses take no place in C.
 */
export function candidateRows<T>(terms: readonly TermRows<T>[], accept: (row: T) => boolean, cap = CANDIDATE_CAP): T[] {
  const chosen = new Set<T>();
  const add = (rows: Iterable<T>, walk: number, limit = Infinity): void => {
    let taken = 0;
    for (const row of take(rows, walk)) {
      if (chosen.size >= cap || taken >= limit) return;
      if (chosen.has(row) || !accept(row)) continue;
      chosen.add(row);
      taken++;
    }
  };
  const ranked = terms.filter((rows) => rows.df > 0).sort((a, b) => a.df - b.df);
  const fat = ranked.filter((rows) => rows.df > FAT_DF);
  for (const rows of ranked) if (rows.df <= FAT_DF) add(rows.newest(), FAT_DF);
  const intersected = fat.slice(0, INTERSECTED);
  const members = new Map<TermRows<T>, Set<T>>();
  const memberOf = (rows: TermRows<T>) => {
    let set = members.get(rows);
    if (!set) members.set(rows, (set = new Set(take(rows.newest(), SCAN_CAP))));
    return set;
  };
  for (let j = 1; j < intersected.length; j++)
    for (let i = 0; i < j; i++) {
      const fatter = memberOf(intersected[j]!);
      add(
        filter(take(intersected[i]!.newest(), SCAN_CAP), (row) => fatter.has(row)),
        SCAN_CAP,
      );
    }
  for (const rows of fat) add(rows.newest(), NEWEST_WALK, FAT_DF);
  return [...chosen];
}

function* take<T>(rows: Iterable<T>, limit: number): Generator<T> {
  let n = 0;
  for (const row of rows) {
    if (n++ >= limit) return;
    yield row;
  }
}

function* filter<T>(rows: Iterable<T>, keep: (row: T) => boolean): Generator<T> {
  for (const row of rows) if (keep(row)) yield row;
}
