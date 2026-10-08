/**
 * Row identity and order (A4 §1; A1 D2, C2).
 *
 * - `id`: a ULID, minted by the writing process. Ids no longer derive from the pid, so two hook processes never mint
 *   the same one (#98), and a process's ids sort in the order it created them.
 * - `seq`: the store's monotonic counter, the order every reader uses. A writer claims a block under the store lock
 *   (`.lock`, a 50 ms wait) and keeps the last claimed value in `seq`. A writer that cannot take the lock in time
 *   appends its rows to `pending.jsonl` with the store they belong to; sleep gives them their `seq` and writes them
 *   into that store (`takePending`).
 *
 * The store is the memory root until P0.5 keys it by repo, so the counter, the lock and the pending rows live there.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { memoryNow } from "./memory-clock";

const LOCK = ".lock";
const COUNTER = "seq";
const PENDING = "pending.jsonl";
/** A pending file taken by a sleep, kept until its rows are in their stores, so a crash loses none. */
const TAKEN = /^pending\.jsonl\.[0-9A-Z]{26}$/;
/** A4 §1: how long a writer waits for the store lock before it leaves its rows to sleep. */
export const SEQ_LOCK_WAIT_MS = 50;

/** A row as a store file holds it: at least an id and a text; `seq` once the store has ordered it. */
export type DiskRow = Record<string, unknown> & { id: string; text: string; seq?: number };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlid = { ms: -1, random: [] as number[] };

function randomDigits(): number[] {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte & 31);
}

/** The random part plus one, in base 32; a process that mints more than 2^80 ids in one millisecond wraps. */
function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]!++;
      return next;
    }
    next[i] = 0;
  }
  return next;
}

/**
 * A ULID: 48 bits of time, 80 random bits, in Crockford base 32. Monotonic within a process: an id minted in the
 * same millisecond as the last (or with a clock that went back) is the last one plus one.
 */
export function ulid(now = memoryNow()): string {
  const ms = Math.max(Math.floor(now), lastUlid.ms);
  const random = ms === lastUlid.ms ? increment(lastUlid.random) : randomDigits();
  lastUlid = { ms, random };
  let time = "";
  for (let rest = ms, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  return time + random.map((digit) => CROCKFORD[digit]).join("");
}

function seqOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function rowsIn(path: string): DiskRow[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      const row =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) && "row" in parsed ? parsed.row : parsed;
      return row && typeof row === "object" && !Array.isArray(row) ? [row as DiskRow] : [];
    } catch {
      return [];
    }
  });
}

/** The highest seq any store file or pending row holds: the counter's value when its file is missing or unreadable. */
function highestSeq(root: string): number {
  let high = 0;
  const note = (rows: DiskRow[]) => {
    for (const row of rows) high = Math.max(high, seqOf(row.seq) ?? 0);
  };
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) note(rowsIn(join(root, entry.name, "memories.jsonl")));
      else if (entry.name === PENDING || TAKEN.test(entry.name)) note(rowsIn(join(root, entry.name)));
    }
  } catch {}
  note(rowsIn(join(root, "memories.jsonl")));
  return high;
}

/** The last seq the store gave out. Call it holding the store lock. */
function lastSeq(root: string): number {
  const path = join(root, COUNTER);
  if (!existsSync(path)) return highestSeq(root);
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : highestSeq(root);
}

function advance(root: string, count: number): number {
  const first = lastSeq(root) + 1;
  writeFileAtomic(join(root, COUNTER), String(first + count - 1), 0o600);
  return first;
}

/**
 * Claims `count` consecutive seqs, returning the first. Undefined when the store lock is not free within 50 ms or
 * the counter cannot be written: the caller then leaves its rows to sleep (`appendPending`).
 */
export function claimSeqs(root: string, count: number): number | undefined {
  if (count <= 0) return undefined;
  try {
    return withFileLock(join(root, LOCK), () => advance(root, count), SEQ_LOCK_WAIT_MS);
  } catch {
    return undefined;
  }
}

/** Leaves rows to sleep: one `{store, row}` line each, appended to `pending.jsonl`. False when it cannot be written. */
export function appendPending(root: string, store: string, rows: readonly DiskRow[]): boolean {
  if (!rows.length) return true;
  try {
    const lines = rows.map((row) => `${JSON.stringify({ store, row })}\n`).join("");
    appendFileSync(join(root, PENDING), lines, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Pending rows taken by a sleep, by store, each with its seq; `done` removes the taken files once they are stored. */
export interface TakenRows {
  byStore: Map<string, DiskRow[]>;
  done(): void;
}

function pendingLines(path: string): { store: string; row: DiskRow }[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return parsePending(text);
}

function parsePending(text: string): { store: string; row: DiskRow }[] {
  return text.split("\n").flatMap((line) => {
    try {
      const { store, row } = JSON.parse(line) as { store?: unknown; row?: DiskRow };
      const valid = typeof store === "string" && typeof row?.id === "string" && typeof row?.text === "string";
      return valid ? [{ store, row }] : [];
    } catch {
      return [];
    }
  });
}

/** The rows waiting for sleep, in `pending.jsonl` and in files a sleep took but has not finished storing. */
export function pendingRows(root: string): { store: string; row: DiskRow }[] {
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((name) => name === PENDING || TAKEN.test(name));
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => pendingLines(join(root, name)));
}

/**
 * Takes the pending rows under the store lock (sleep's wait, not a writer's): renames `pending.jsonl` aside and
 * gives each row without a seq the next one, in the order they were left. The rows of an earlier sleep that did not
 * finish are taken again and get new seqs; one already merged into its store keeps the seq it has there
 * (`mergeRow`), so a retry leaves only gaps. A writer appends without the lock, so one that opened `pending.jsonl`
 * before the rename may append to the taken file after it was read: `done` puts such lines back.
 */
export function takePending(root: string): TakenRows | undefined {
  try {
    return withFileLock(join(root, LOCK), () => {
      if (existsSync(join(root, PENDING))) renameSync(join(root, PENDING), join(root, `${PENDING}.${ulid()}`));
      const taken = readdirSync(root)
        .filter((name) => TAKEN.test(name))
        .sort()
        .map((name) => ({ path: join(root, name), bytes: readFileSync(join(root, name)) }));
      const lines = taken.flatMap(({ bytes }) => parsePending(bytes.toString("utf8")));
      const unsequenced = lines.filter(({ row }) => seqOf(row.seq) === undefined);
      if (unsequenced.length) {
        let next = advance(root, unsequenced.length);
        for (const { row } of unsequenced) row.seq = next++;
      }
      const byStore = new Map<string, DiskRow[]>();
      for (const { store, row } of lines) byStore.set(store, [...(byStore.get(store) ?? []), row]);
      return {
        byStore,
        done: () => {
          for (const { path, bytes } of taken) {
            const late = readFileSync(path).subarray(bytes.length);
            if (late.length) appendFileSync(join(root, PENDING), late, { mode: 0o600 });
            rmSync(path, { force: true });
          }
        },
      };
    });
  } catch {
    return undefined;
  }
}

/** What orders a row: its store `seq`, its time and its id. */
export type Ordered = { id: string; seq?: number; at?: number };

/**
 * Rows in store order, oldest first (A4 §1; A1 C2: list numbers are not clocks). A row with a `seq` is ordered by
 * it. A row still waiting for one was written by this process after it read the store, so it is newer, and such
 * rows keep the order they were written in (time, then ULID). A row written before P0.3 has neither and is oldest.
 */
export function compareRecency(a: Ordered, b: Ordered): number {
  const rank = (r: Ordered) => (typeof r.seq === "number" ? 1 : typeof r.at === "number" ? 2 : 0);
  return (
    rank(a) - rank(b) ||
    (a.seq ?? 0) - (b.seq ?? 0) ||
    (a.at ?? 0) - (b.at ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Rows in store order, each with a time that never goes back along it: the time `assemble` compares, so the value it
 * keeps (the latest time, the later of two equal ones) is the one store order keeps.
 */
export function inStoreOrder<T extends Ordered>(rows: readonly T[]): { row: T; t: number }[] {
  let latest = 0;
  return [...rows].sort(compareRecency).map((row) => ({ row, t: (latest = Math.max(latest, row.at ?? 0)) }));
}
