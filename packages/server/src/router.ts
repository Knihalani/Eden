/**
 * The multi-process router (D113 stage 1, D163): one Bun.serve front and N child server processes (`main.ts` with
 * EDEN_ROUTER_CHILD="i/N"), started when EDEN_PROCESSES is above 1. Every piece of per-user state (cache, sessions,
 * budgets, reader and card caches, sync) lives in the one process that serves the user, so the engine's work spreads
 * over cores only if each user always reaches the same process: the router sends each request to child
 * `childFor(tenant, userId, N)`, a stable hash of the tenant (from the API key, as http.ts reads it) and the body's
 * `userId`. Sticky by construction: no table, nothing to keep or forget here.
 *
 * Changing N reshuffles users: most land on another child, where their in-memory state starts over (as after any
 * restart, D8) and the source-map rows the old child wrote are not read. Those rows hold per-user entity names, so
 * forget must still reach them: `/v1/forget` goes to every child (rare and cheap), each deleting the user's rows from
 * its own file, and answers with the owning child's answer, or 503 when any child could not forget. Files no current
 * child opens (`source-map.db` when N > 1, `source-map.<i>.db` for i >= N, or every `.<i>` file when N is 1) are
 * merged into the current set before any child starts (`rehomeSourceMaps`): each user's rows go to the file of the
 * child that now serves them and the stranded file is deleted, so no file is left that forget never reaches.
 *
 * What changes with N children (D163), each in the child, not here:
 * - each child has its own source-map file (`childSourceMapPath`), since one SQLite file must have one writer;
 * - each child holds 1/N of every per-tenant cap: the GCRA rate and burst (`loadConfig`) and the daily model spend
 *   (`buildPartner`'s `processes`). A tenant whose users hash unevenly reaches its cap sooner on the busier child.
 *
 * Failure: a child that is down (exited, not yet restarted, or refusing the connection) gives its users 503
 * `{error}` ("temporarily unable to serve context", what an integration treats as silence), never a 500, while the
 * other children keep serving. An exited child is started again after `restartMs` (doubling to 30 s while it keeps
 * failing); its users' in-memory state is gone, as after any restart (D8), and its source-map file is reopened.
 * Every start, a restart included, has its own deadline (`startTimeoutMs`, D172): a child that has not reported its
 * port by then is killed (SIGKILL), so a start-up stall (a wedged gate worker, a slow file open) becomes one more
 * failed start, retried with the same backoff, instead of a child that holds 1/N of the users at 503 forever.
 * `/healthz` answers here: 200 while at least one child is up (`up` < `processes` in the body says the instance is
 * degraded: alert on that, but a load balancer must not pull every user for one child's 1/N), 503 when none is.
 *
 * The router reads each POST body once to find `userId` (a `JSON.parse` the child repeats; router.bench.ts measures
 * the hop) and forwards the bytes unchanged with the `authorization` and `content-type` headers. A declared
 * content-length past `maxBodyBytes` is refused here with the handler's 413 (D100) so it is never buffered twice,
 * and a request past the tenant's whole rate (`tenantRatePerSec`, `tenantBurst`, undivided) gets the handler's 429
 * here before its body is read; every other answer, auth, the child's own 1/N rate limit and validation included, is
 * the child's.
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceMap } from "@eden/graph";
import { childTable, Gcra } from "@eden/primitives";
import { BODY_MAX_DEPTH, BODY_MAX_VALUES, bucketOf, keylessOriginAllowed } from "@eden/protocol";
import { keyOf } from "./auth";
import { childSourceMapPath, DEFAULT_MAX_BODY_BYTES, FANOUT_COPY, MAX_PROCESSES, type ServerConfig } from "./config";
import { clusterKeyMatches, sumMetrics } from "./ops";
import { prunePersistDirs } from "./persist";

const tables = new Map<number, Uint8Array>();

/**
 * The child a tenant/user is served by: stable across restarts and router instances. Since D992 by the user's bucket
 * (`bucketOf`) through a jump-hash table (`childTable`): going from N to N+1 children moves 1/(N+1) of users, all to
 * the new child, where `mod N` moved N/(N+1) of them; and a child owns whole buckets, which is what lets every child
 * share one persistence directory (each reads only its buckets' files).
 */
export function childFor(tenant: string, userId: string, children: number): number {
  if (children <= 1) return 0;
  let t = tables.get(children);
  if (!t) tables.set(children, (t = childTable(children)));
  return t[bucketOf(tenant, userId)]!;
}

/**
 * The top-level `userId` of a JSON body, or "" when there is none (not JSON, not an object, no string userId, or a
 * body past `bodyShapeUnder`'s bounds, which the child refuses unparsed). Exactly what `JSON.parse` of the decoded body
 * gave (the last of duplicate keys, an escaped key read as its characters, a nested `"userId"` ignored: one inside an
 * item's `meta` must not route a request), without the parse: one pass over the bytes checks the whole body against
 * JSON's grammar and `bodyShapeUnder`'s bounds and notes where the last top-level `userId` value lies, and only that
 * value is decoded. The parse built every item's strings and objects to read one key, on the one thread every tenant's
 * requests pass through (D1925; `router-user.test.ts` fuzzes this against it). Requests without one go to the
 * tenant's own child, where the handler refuses them with its usual 400.
 */
export function userOf(body: Uint8Array): string {
  const b = body;
  const n = b.length;
  let i = 0;
  // The decode the parse ran dropped one leading BOM (TextDecoder's default); any other byte not JSON's is invalid.
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  scan.quote = scan.slash = scan.control = -1;
  scan.words = null;
  scan.run = 32;
  while (i < n && WS[b[i]!] === 1) i++;
  // Not an object: no userId, whatever follows (a body past the bounds or not JSON gives "" all the same).
  if (i >= n || b[i] !== 0x7b) return "";
  const kinds = KINDS; // the container open at each depth: 1 an object, 2 an array
  let depth = 0;
  let values = 0; // opening brackets and commas, as `bodyShapeUnder` counts them
  let userStart = -1; // the last top-level userId value's span
  let userEnd = -1;
  let userEscaped = false;
  let valueStart = -1; // where the value of a top-level userId key starts, until that value ends
  for (;;) {
    // A value starts at `i`, past any whitespace.
    while (i < n && WS[b[i]!] === 1) i++;
    if (i >= n) return "";
    let c = b[i]!;
    if (c === 0x7b || c === 0x5b) {
      if (++depth > BODY_MAX_DEPTH || ++values > BODY_MAX_VALUES) return "";
      const object = c === 0x7b;
      kinds[depth] = object ? 1 : 2;
      i++;
      while (i < n && WS[b[i]!] === 1) i++;
      if (i >= n) return "";
      if (b[i] === (object ? 0x7d : 0x5d)) {
        depth--;
        i++;
      } else {
        if (object) {
          if ((i = memberValue(b, i, depth)) < 0) return "";
          if (depth === 1 && keyIsUser) valueStart = i;
        }
        continue;
      }
    } else if (c === 0x22) {
      if ((i = stringEnd(b, i + 1)) < 0) return "";
      i++;
    } else if ((i = scalarEnd(b, i)) < 0) return "";
    // A value ended at `i`: what follows it in its container, closing containers until a comma.
    for (;;) {
      if (depth === 1 && valueStart >= 0) {
        userStart = valueStart;
        userEnd = i;
        userEscaped = escaped; // the value's own scan, when it is a string
        valueStart = -1;
      }
      while (i < n && WS[b[i]!] === 1) i++;
      if (depth === 0) {
        if (i !== n) return "";
        if (userStart < 0 || b[userStart] !== 0x22) return "";
        // Without an escape the characters are the bytes' decoding, as the parse's decode made them.
        return userEscaped ? stringAt(b, userStart, userEnd) : decoder.decode(b.subarray(userStart + 1, userEnd - 1));
      }
      if (i >= n) return "";
      c = b[i]!;
      if (c === 0x2c) {
        if (++values > BODY_MAX_VALUES) return "";
        i++;
        if (kinds[depth] === 1) {
          while (i < n && WS[b[i]!] === 1) i++;
          if ((i = memberValue(b, i, depth)) < 0) return "";
          if (depth === 1 && keyIsUser) valueStart = i;
        }
        break;
      }
      if (c !== (kinds[depth] === 1 ? 0x7d : 0x5d)) return "";
      depth--;
      i++;
    }
  }
}

/** JSON's whitespace: space, tab, line feed, carriage return. */
const WS = new Uint8Array(256);
WS[0x20] = WS[0x09] = WS[0x0a] = WS[0x0d] = 1;
/** The bytes after a backslash that make an escape, `u` apart (it needs four hex digits). */
const ESCAPE = new Uint8Array(256);
for (const c of '"\\/bfnrt') ESCAPE[c.charCodeAt(0)] = 1;
const HEX = new Uint8Array(256);
for (const c of "0123456789abcdefABCDEF") HEX[c.charCodeAt(0)] = 1;
const DIGIT = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) DIGIT[c] = 1;
/** Container kinds by depth: depth is bounded (`BODY_MAX_DEPTH`), so one array serves every call. */
const KINDS = new Uint8Array(BODY_MAX_DEPTH + 2);
/** Whether the key `memberValue` last read at depth 1 is `userId`. */
let keyIsUser = false;
/** Whether the string `stringEnd` last scanned held an escape. */
let escaped = false;
const USER_ID = [0x75, 0x73, 0x65, 0x72, 0x49, 0x64]; // "userId"

/**
 * Reads an object member's key at `i` and its colon; returns where its value starts (past whitespace), or -1 when the
 * bytes are not a key and a colon. At depth 1 sets `keyIsUser`: the key's characters are `userId`, compared byte by
 * byte when it holds no escape and decoded as the parse would (`userId` is `userId` to it) when it does.
 */
function memberValue(b: Uint8Array, i: number, depth: number): number {
  const n = b.length;
  if (i >= n || b[i] !== 0x22) return -1;
  const end = stringEnd(b, i + 1);
  if (end < 0) return -1;
  if (depth === 1) {
    if (!escaped) {
      keyIsUser = end - i - 1 === 6;
      for (let k = 0; keyIsUser && k < 6; k++) keyIsUser = b[i + 1 + k] === USER_ID[k];
    } else keyIsUser = end - i - 1 <= 36 && stringAt(b, i, end + 1) === "userId"; // at most six `\uXXXX`
  }
  let j = end + 1;
  while (j < n && WS[b[j]!] === 1) j++;
  if (j >= n || b[j] !== 0x3a) return -1;
  j++;
  while (j < n && WS[b[j]!] === 1) j++;
  return j;
}

/**
 * The index of the quote that ends the string whose characters start at `i`, or -1 when the string is not valid JSON
 * (unended, a control character, a bad escape). Bytes past 0x7f pass: the decode turned invalid UTF-8 into U+FFFD,
 * which a string may hold, and UTF-8 never puts a byte under 0x80 inside a multi-byte character.
 *
 * Strings are most of a large body's bytes, and a byte loop reads about a byte a nanosecond. So past a short run read
 * byte by byte (most strings, and most gaps between escapes, are short), the next quote and backslash are found with
 * the native `indexOf` (13-16 µs a MiB on Bun, D1870) and the next control byte four at a time (`nextControl`). Each
 * position found is kept until the scan passes it (`scan`), so each search covers a byte at most once whatever the
 * number of strings or escapes; where the stop found was near, the run doubles (to 4,096), as D1870's does, since a
 * search there costs more than the loop (text with an escaped quote or newline every few dozen bytes).
 */
function stringEnd(b: Uint8Array, i: number): number {
  const n = b.length;
  escaped = false;
  for (;;) {
    const stop = i + scan.run < n ? i + scan.run : n;
    while (i < stop && STR_STOP[b[i]!] === 0) i++;
    let at = i;
    if (i === stop) {
      if (i >= n) return -1;
      if (scan.quote < i) scan.quote = found(b.indexOf(0x22, i), n);
      if (scan.slash < i) scan.slash = found(b.indexOf(0x5c, i), n);
      if (scan.control < i) scan.control = nextControl(b, i);
      at = scan.quote < scan.slash ? scan.quote : scan.slash;
      if (scan.control < at) at = scan.control;
      scan.run = at - i < 128 ? Math.min(scan.run * 2, 4096) : 32;
      if (at >= n) return -1;
    }
    const c = b[at]!;
    if (c === 0x22) return at;
    if (c !== 0x5c || at + 1 >= n) return -1;
    escaped = true;
    const e = b[at + 1]!;
    if (e === 0x75) {
      if (at + 5 >= n || !HEX[b[at + 2]!] || !HEX[b[at + 3]!] || !HEX[b[at + 4]!] || !HEX[b[at + 5]!]) return -1;
      i = at + 6;
    } else if (ESCAPE[e] === 1) i = at + 2;
    else return -1;
  }
}

/** Bytes that end a string's byte loop: a quote, a backslash, or a control character (invalid unescaped). */
const STR_STOP = new Uint8Array(256);
for (let c = 0; c < 0x20; c++) STR_STOP[c] = 1;
STR_STOP[0x22] = STR_STOP[0x5c] = 1;

/** `indexOf`'s answer with "none" as `n`. */
const found = (at: number, n: number) => (at < 0 ? n : at);

/**
 * `stringEnd`'s state for the body `userOf` is reading (reset at its start): the byte run, and the next quote,
 * backslash and control byte at or after the position each was last searched from (one below the scan's position
 * means "search again"), and the body's `Uint32Array` view once `nextControl` made it.
 */
const scan = { run: 32, quote: -1, slash: -1, control: -1, words: null as Uint32Array | null, base: 0 };

/** The first byte under 0x20 at or after `i`, or `b.length`: four at a time over an aligned `Uint32Array` view. */
function nextControl(b: Uint8Array, i: number): number {
  const n = b.length;
  if (n - i >= 64) {
    if (scan.words === null) {
      // A view from the word boundary at or before the body's start; only words wholly inside the body are read.
      scan.base = b.byteOffset & ~3;
      scan.words = new Uint32Array(b.buffer, scan.base, (b.byteOffset + n - scan.base) >> 2);
    }
    const lead = b.byteOffset - scan.base; // the view's offset of byte 0
    for (; ((lead + i) & 3) !== 0; i++) if (b[i]! < 0x20) return i;
    const w = scan.words;
    let k = (lead + i) >> 2;
    // Any byte of x under 0x20 sets its high bit here (and none is set without one): Hacker's Delight's `hasless`.
    for (const end = w.length; k < end; k++) if (((w[k]! - 0x20202020) & ~w[k]! & 0x80808080) !== 0) break;
    i = (k << 2) - lead;
  }
  while (i < n && b[i]! >= 0x20) i++;
  return i;
}

/** The end of the number, `true`, `false` or `null` at `i`, or -1 when none starts there (JSON's number grammar). */
function scalarEnd(b: Uint8Array, i: number): number {
  const n = b.length;
  const c = b[i]!;
  if (c === 0x74) return word(b, i, TRUE);
  if (c === 0x66) return word(b, i, FALSE);
  if (c === 0x6e) return word(b, i, NULL);
  if (c === 0x2d) i++;
  if (i >= n) return -1;
  if (b[i] === 0x30) i++;
  else if (b[i]! >= 0x31 && b[i]! <= 0x39) while (i < n && DIGIT[b[i]!] === 1) i++;
  else return -1;
  if (i < n && b[i] === 0x2e) {
    const from = ++i;
    while (i < n && DIGIT[b[i]!] === 1) i++;
    if (i === from) return -1;
  }
  if (i < n && (b[i] === 0x65 || b[i] === 0x45)) {
    i++;
    if (i < n && (b[i] === 0x2b || b[i] === 0x2d)) i++;
    const from = i;
    while (i < n && DIGIT[b[i]!] === 1) i++;
    if (i === from) return -1;
  }
  return i;
}

const TRUE = [0x74, 0x72, 0x75, 0x65];
const FALSE = [0x66, 0x61, 0x6c, 0x73, 0x65];
const NULL = [0x6e, 0x75, 0x6c, 0x6c];
/** The end of literal `w` at `i`, or -1. */
function word(b: Uint8Array, i: number, w: number[]): number {
  if (i + w.length > b.length) return -1;
  for (let k = 0; k < w.length; k++) if (b[i + k] !== w[k]) return -1;
  return i + w.length;
}

/** The string whose quotes are at `from` and `to - 1`, decoded as the parse decoded it. */
function stringAt(b: Uint8Array, from: number, to: number): string {
  return JSON.parse(decoder.decode(b.subarray(from, to))) as string;
}

/**
 * Moves the source-map rows of files that no process of an N-process server opens into the files it does (D163), then
 * deletes the stranded files. Owned: `base` when N is 1, else `childSourceMapPath(base, i)` for i < N. Each user's
 * rows go to the file of `childFor(tenant, user, N)`: counts add up (`mention`, `utility`), a planner arm already in
 * the target wins. Run before any process opens the files (the router before its children, `main.ts` before
 * `buildPartner`). Returns the stranded files it merged. Throws, so the server does not start, when a stranded file
 * cannot be read or deleted: a file left behind would hold rows that `/v1/forget` never reaches.
 *
 * Not atomic across files: each target is one transaction that copies a user's rows and deletes them from the
 * stranded file, but SQLite in WAL mode commits each attached file on its own, so a crash between the two commits can
 * leave a row in both. The next start moves it again and its counts add twice (learning only, which shrugs it off);
 * no row is ever lost to forget, which reaches every current file and leaves no stranded one.
 */
export function rehomeSourceMaps(base: string, n: number, log: (line: string) => void = console.error): string[] {
  if (base === "" || base === ":memory:") return [];
  const owned = n <= 1 ? [base] : Array.from({ length: n }, (_, i) => childSourceMapPath(base, i));
  const candidates = [base, ...Array.from({ length: MAX_PROCESSES }, (_, i) => childSourceMapPath(base, i))];
  const stranded = candidates.filter((f) => !owned.includes(f) && existsSync(f));
  for (const file of stranded) {
    const src = new Database(file);
    let users = 0;
    try {
      src.exec("PRAGMA busy_timeout = 2000");
      const tables = new Set(
        (src.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
      const present = TABLES.filter((t) => tables.has(t));
      const byOwner = new Map<number, string[]>();
      const scopes = new Set<string>();
      for (const t of present) {
        for (const { scope } of src.query(`SELECT DISTINCT scope FROM ${t}`).all() as { scope: string }[]) {
          scopes.add(scope);
        }
      }
      for (const scope of scopes) {
        // Scope keys are "tenant/user" (protocol's scopeKey); a tenant id never holds "/" (config.ts checks isId).
        const slash = scope.indexOf("/");
        const owner = slash < 0 ? 0 : childFor(scope.slice(0, slash), scope.slice(slash + 1), n);
        let list = byOwner.get(owner);
        if (!list) byOwner.set(owner, (list = []));
        list.push(scope);
      }
      users = scopes.size;
      for (const [owner, list] of byOwner) mergeInto(owned[owner]!, file, present, list);
    } finally {
      src.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    log(
      `eden: EDEN_PROCESSES is ${n}; moved the source-map rows of ${users} users from ${file}, which no process ` +
        `opens any more, into the current files and deleted it`,
    );
  }
  return stranded;
}

const TABLES = ["mention", "utility", "planner_arm"] as const;

/** One transaction on `target`: copy `scopes`' rows from the attached stranded file, then delete them there. */
function mergeInto(target: string, from: string, tables: readonly string[], scopes: string[]): void {
  // Creates the schema in a target no child has opened yet, exactly as the child will.
  new SourceMap(target).close();
  const db = new Database(target);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.query("ATTACH DATABASE ? AS stranded").run(from);
    db.transaction(() => {
      db.exec("CREATE TEMP TABLE moving (scope TEXT PRIMARY KEY)");
      const add = db.query("INSERT OR IGNORE INTO moving (scope) VALUES (?)");
      for (const scope of scopes) add.run(scope);
      const moving = "scope IN (SELECT scope FROM temp.moving)";
      if (tables.includes("mention")) {
        db.exec(`INSERT INTO main.mention (scope, entity, source_id, count, last_seen)
          SELECT scope, entity, source_id, count, last_seen FROM stranded.mention WHERE ${moving}
          ON CONFLICT (scope, entity, source_id) DO UPDATE SET count = count + excluded.count,
            last_seen = MAX(last_seen, excluded.last_seen)`);
      }
      if (tables.includes("utility")) {
        db.exec(`INSERT INTO main.utility (scope, situation, source_id, shown, used)
          SELECT scope, situation, source_id, shown, used FROM stranded.utility WHERE ${moving}
          ON CONFLICT (scope, situation, source_id) DO UPDATE SET shown = shown + excluded.shown,
            used = used + excluded.used`);
      }
      if (tables.includes("planner_arm")) {
        db.exec(`INSERT INTO main.planner_arm (scope, source_id, bucket, shape, alpha, beta)
          SELECT scope, source_id, bucket, shape, alpha, beta FROM stranded.planner_arm WHERE ${moving}
          ON CONFLICT (scope, source_id, bucket, shape) DO NOTHING`);
      }
      for (const t of tables) db.exec(`DELETE FROM stranded.${t} WHERE ${moving}`);
      db.exec("DROP TABLE temp.moving");
    })();
    db.exec("DETACH DATABASE stranded");
  } finally {
    db.close();
  }
}

const decoder = new TextDecoder();
const UNAVAILABLE = "temporarily unable to serve context";
const MAX_RESTART_MS = 30_000;
/** The router kills a child this many times the shutdown grace after its SIGTERM (R1: the child's steps fill it). */
export const KILL_AFTER_GRACE = 1.25;

export interface RouterOptions {
  /** The router's own configuration (`loadConfig`): port, host, keys, dev, body cap, source-map base, processes. */
  config: Pick<ServerConfig, "port" | "host" | "keys" | "dev" | "sourceMapPath" | "processes"> &
    Partial<
      Pick<
        ServerConfig,
        "maxBodyBytes" | "tenantRatePerSec" | "tenantBurst" | "persist" | "cluster" | "shutdownGraceMs" | "drainDelayMs"
      >
    >;
  /** The environment each child starts from (default `process.env`); the router sets its own variables over it. */
  env?: Record<string, string | undefined>;
  /** The child entry (default `main.ts` beside this file). */
  entry?: string;
  /** Wait before an exited child is started again; default 1,000 ms, doubled while it keeps failing to start. */
  restartMs?: number;
  /**
   * How long each start of a child (the first and every restart) may take to report its port before it is killed;
   * default 30 s. A first start past it fails `startRouter`; a restart past it is retried with backoff (D172).
   */
  startTimeoutMs?: number;
  /** Receives each child's stdout (tests, the bench); unset, children write to the router's stdout. */
  onOutput?: (index: number, text: string) => void;
  /** Told each child's pid as it is spawned (tests check that a failed start leaves no child running). */
  onSpawn?: (index: number, pid: number) => void;
  /** Operational lines (a child exited, restarted); default stderr. */
  log?: (line: string) => void;
}

export interface ChildState {
  readonly index: number;
  pid: number;
  /** The child's listening port on 127.0.0.1, or 0 while it is down. */
  port: number;
  up: boolean;
}

export interface Router {
  readonly port: number;
  readonly hostname: string;
  readonly children: readonly ChildState[];
  /**
   * Drains and stops (D992): `/readyz` turns 503, in-flight requests finish (up to 40% of the shutdown grace), then
   * every child gets SIGTERM, and SIGKILL if still running after the grace (`EDEN_SHUTDOWN_GRACE_MS`, default 10 s).
   */
  stop(): Promise<void>;
}

interface Child extends ChildState {
  proc: ReturnType<typeof Bun.spawn> | null;
  restartMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Starts N children, waits until each listens, then serves. Rejects (stopping them all) if any fails to start. */
export async function startRouter(options: RouterOptions): Promise<Router> {
  const { config } = options;
  const n = config.processes;
  const env = options.env ?? process.env;
  const entry = options.entry ?? fileURLToPath(new URL("./main.ts", import.meta.url));
  const baseRestartMs = options.restartMs ?? 1_000;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const log = options.log ?? console.error;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const tooLarge = `body must be at most ${maxBodyBytes.toLocaleString("en-US")} bytes`;
  let stopping = false;
  let draining = false;
  const grace = config.shutdownGraceMs ?? 10_000;

  const children: Child[] = Array.from({ length: n }, (_, index) => ({
    index,
    pid: 0,
    port: 0,
    up: false,
    proc: null,
    restartMs: baseRestartMs,
    timer: null,
  }));

  /** The last membership a child accepted (`/internal/cluster`), replayed to a child that (re)starts after it. */
  let lastMembership: { auth: string; body: Uint8Array } | null = null;
  /**
   * Children listening and being told `lastMembership`, not up yet: a newer membership reaches them too (review of
   * R1), or one that lands during the replay would be missed and the child would serve on the older table. The
   * child's epoch check keeps the newer one whatever order they arrive in.
   */
  const replaying = new Set<Child>();
  /** A membership being sent to the children now (`clusterEverywhere`): a replay sends it rather than the last. */
  let deliveringMembership: { auth: string; body: Uint8Array } | null = null;
  const replayMembership = async (port: number): Promise<void> => {
    // Until what it sent is still the newest: a membership that began its fan-out before this child was `replaying`
    // skipped it, so the replay sends that one too (at most a few rounds; the epoch check orders them).
    let sent: { auth: string; body: Uint8Array } | null = null;
    for (let round = 0; round < 4; round++) {
      const m = deliveringMembership ?? lastMembership;
      if (!m || m === sent) return;
      sent = m;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/internal/cluster`, {
          method: "POST",
          headers: { authorization: m.auth, "content-type": "application/json" },
          body: m.body,
          signal: AbortSignal.timeout(10_000),
        });
        await r.arrayBuffer();
      } catch {
        // The child serves as before (no table); the cluster router's next membership reaches it.
        return;
      }
    }
  };

  // Each start resolves when the child reports its port, rejects if it exits first or misses its deadline (it is then
  // killed, and its exit takes the usual path: logged, and restarted with backoff unless the router is stopping).
  const spawn = (c: Child): Promise<void> =>
    new Promise((resolve, reject) => {
      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
      delete childEnv.EDEN_PROCESSES;
      Object.assign(childEnv, {
        PORT: "0",
        HOST: "127.0.0.1",
        EDEN_ROUTER_CHILD: `${c.index}/${n}`,
        EDEN_SOURCE_MAP: childSourceMapPath(config.sourceMapPath, c.index),
      });
      let ready = false;
      let timedOut = false;
      // Assigned just below, before any IPC message or exit can be delivered (both arrive on later ticks).
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const proc = Bun.spawn([process.execPath, entry], {
        env: childEnv,
        stdin: "ignore",
        stdout: options.onOutput ? "pipe" : "inherit",
        stderr: "inherit",
        ipc(message) {
          const port = (message as { edenListening?: unknown } | null)?.edenListening;
          if (ready || typeof port !== "number") return;
          ready = true;
          clearTimeout(deadline);
          c.port = port;
          // A restarted child is told the last cluster membership before it serves (R1): without it it has no table,
          // so no fence, and it would write and delete store copies of buckets this machine no longer owns.
          replaying.add(c);
          void replayMembership(port).finally(() => {
            replaying.delete(c);
            if (c.proc === proc) {
              c.up = true;
              c.restartMs = baseRestartMs;
            }
            resolve();
          });
        },
      });
      c.proc = proc;
      c.pid = proc.pid;
      deadline = setTimeout(() => {
        if (ready || c.proc !== proc) return;
        timedOut = true;
        log(
          `eden router: child ${c.index} (pid ${proc.pid}) did not report its port in ${startTimeoutMs} ms; ` +
            `killing it`,
        );
        proc.kill("SIGKILL");
      }, startTimeoutMs);
      options.onSpawn?.(c.index, proc.pid);
      if (options.onOutput && proc.stdout instanceof ReadableStream) void pipeOut(proc.stdout, c.index);
      void proc.exited.then((code) => {
        clearTimeout(deadline);
        if (c.proc !== proc) return;
        c.up = false;
        c.port = 0;
        c.proc = null;
        if (timedOut) reject(new Error(`eden router: child ${c.index} did not start in ${startTimeoutMs} ms`));
        else if (!ready) reject(new Error(`eden router: child ${c.index} exited with code ${code} before listening`));
        if (stopping) return;
        log(
          `eden router: child ${c.index} (pid ${proc.pid}) exited with code ${code}; restarting in ${c.restartMs} ms`,
        );
        const wait = c.restartMs;
        c.restartMs = Math.min(MAX_RESTART_MS, c.restartMs * 2);
        c.timer = setTimeout(() => {
          c.timer = null;
          if (!stopping) spawn(c).catch(() => {}); // A failed restart logs from its own exit and is retried.
        }, wait);
      });
    });

  const pipeOut = async (stream: ReadableStream<Uint8Array>, index: number) => {
    const text = new TextDecoder();
    for await (const chunk of stream) options.onOutput!(index, text.decode(chunk, { stream: true }));
  };

  const stopChildren = async () => {
    stopping = true;
    await Promise.all(
      children.map(async (c) => {
        if (c.timer) clearTimeout(c.timer);
        const proc = c.proc;
        if (!proc) return;
        proc.kill("SIGTERM");
        // A child drains, writes its live users and settles its store writes within the grace (main.ts). Its steps
        // fill the grace almost exactly and `persistLive` checks its deadline only between users, so the kill waits a
        // quarter longer (R1): a SIGKILL at the grace itself cut store writes and the source map's last batch.
        const killer = setTimeout(() => proc.kill("SIGKILL"), grace * KILL_AFTER_GRACE);
        await proc.exited;
        clearTimeout(killer);
      }),
    );
  };

  // Before any child opens its file: no row may sit in a file no child of this N reaches (forget would miss it).
  rehomeSourceMaps(config.sourceMapPath, n, log);
  // D992: every child shares the directory and reads only its own buckets, so a new N needs nothing moved; the
  // per-process directories of the layout before it are deleted (their users re-sync once).
  if (config.persist) prunePersistDirs(config.persist.dir);

  // Each spawn carries its own deadline, so this settles within `startTimeoutMs` (plus the kill) either way. On a
  // failure the exit handler has already scheduled a restart; stopChildren sets `stopping` and clears that timer
  // before it can fire, then stops every child still starting or up, so a failed start leaves no process behind.
  try {
    await Promise.all(children.map(spawn));
  } catch (e) {
    await stopChildren();
    throw e;
  }

  const tenantOf = (req: Request): string | null => {
    const key = keyOf(req);
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    return config.dev && !key ? "dev" : null;
  };
  const fail = (status: number, error: string) => Response.json({ error }, { status });
  // The tenant's whole rate and burst (each child holds 1/N of them): past it, a request is refused here before its
  // body is read, as one process refuses it (http.ts). Otherwise a tenant over its rate still had every body buffered
  // and parsed on the router's one thread, unlimited, before a child could say 429, starving every other tenant.
  const limiter = new Gcra({ ratePerSec: config.tenantRatePerSec ?? 200, burst: config.tenantBurst ?? 400 });

  const forward = async (
    c: Child,
    req: Request,
    url: URL,
    body: Uint8Array | undefined,
    copy = false,
  ): Promise<Response> => {
    if (!c.up) return fail(503, UNAVAILABLE);
    const headers: Record<string, string> = {};
    // A fan-out's copy to a child that does not own the user (forget, usage): served, but not counted as a request
    // of the tenant's (D326), so `/v1/usage` sums to one per call. The router sets it; a caller's own is not forwarded.
    if (copy) headers[FANOUT_COPY] = "1";
    const auth = req.headers.get("authorization");
    if (auth !== null) headers.authorization = auth;
    const type = req.headers.get("content-type");
    if (type !== null) headers["content-type"] = type;
    try {
      return await fetch(`http://127.0.0.1:${c.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch {
      // Refused or reset: the child died under this request, or between its exit and the router hearing of it.
      return fail(503, UNAVAILABLE);
    }
  };

  // Forget goes to every child (D163): after N changed, a child other than the owner can still hold the user's
  // source-map rows. The caller gets the owner's answer (its 400 for a bad body, say); a 2xx there with any other
  // child down or failing is a 503, so the caller retries until every file is clean.
  const forgetEverywhere = async (owner: Child, req: Request, url: URL, body: Uint8Array): Promise<Response> => {
    const answers = await Promise.all(children.map((c) => forward(c, req, url, body, c !== owner)));
    const mine = answers[owner.index]!;
    for (const r of answers) if (r !== mine) void r.arrayBuffer().catch(() => {}); // Frees each connection.
    if (mine.status < 200 || mine.status >= 300) return mine;
    if (answers.some((r) => r.status < 200 || r.status >= 300)) return fail(503, UNAVAILABLE);
    return mine;
  };

  // Usage (D326) is the tenant's across every child: their numbers summed (`processesDown` counts those that did not
  // answer), the owner's answer when it is a 4xx (a bad body), 503 when no child answered.
  const usageEverywhere = async (owner: Child, req: Request, url: URL, body: Uint8Array): Promise<Response> => {
    const answers = await Promise.all(children.map((c) => forward(c, req, url, body, c !== owner)));
    const mine = answers[owner.index]!;
    if (mine.status >= 400 && mine.status < 500) {
      for (const r of answers) if (r !== mine) void r.arrayBuffer().catch(() => {});
      return mine;
    }
    const parts: Record<string, unknown>[] = [];
    for (const r of answers) {
      if (r.status < 200 || r.status >= 300) {
        void r.arrayBuffer().catch(() => {});
        continue;
      }
      try {
        parts.push((await r.json()) as Record<string, unknown>);
      } catch {
        // A child that died mid-answer is left out, as a down one.
      }
    }
    if (parts.length === 0) return fail(503, UNAVAILABLE);
    return Response.json({ ...sumUsage(parts), processesDown: n - parts.length });
  };

  // D992: every child's metrics summed, with the router's own children-up gauge.
  const metricsEverywhere = async (): Promise<Response> => {
    const texts = await Promise.all(
      children.map((c) =>
        c.up
          ? fetch(`http://127.0.0.1:${c.port}/metrics`).then(
              (r) => (r.ok ? r.text() : ""),
              () => "",
            )
          : Promise.resolve(""),
      ),
    );
    const up = children.filter((c) => c.up).length;
    const own =
      "# HELP eden_router_children_up Child processes up\n# TYPE eden_router_children_up gauge\n" +
      `eden_router_children_up ${up}\n# HELP eden_router_children Child processes configured\n` +
      `# TYPE eden_router_children gauge\neden_router_children ${n}\n`;
    return new Response(sumMetrics([own, ...texts]), { headers: { "content-type": "text/plain; version=0.0.4" } });
  };

  // D992: the cluster router's membership, checked here and sent to every child; their answers summed. A child that
  // is down is skipped: a restarted child holds no users (its memory started over), so it has nothing to release.
  const clusterEverywhere = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return fail(405, "POST only");
    if (!clusterKeyMatches(config.cluster?.key ?? undefined, req)) return fail(401, "missing or wrong cluster key");
    const body = new Uint8Array(await req.arrayBuffer());
    const membership = { auth: req.headers.get("authorization") ?? "", body };
    deliveringMembership = membership;
    const answers = await Promise.all(
      children.map(async (c) => {
        if (!c.up && !replaying.has(c)) return null;
        try {
          const r = await fetch(`http://127.0.0.1:${c.port}/internal/cluster`, {
            method: "POST",
            headers: { authorization: req.headers.get("authorization") ?? "", "content-type": "application/json" },
            body,
          });
          return r.ok ? ((await r.json()) as Record<string, number>) : null;
        } catch {
          return null;
        }
      }),
    );
    if (deliveringMembership === membership) deliveringMembership = null;
    const got = answers.filter((a): a is Record<string, number> => a !== null);
    if (got.length === 0) return fail(503, UNAVAILABLE);
    lastMembership = membership;
    const sum = { released: 0, written: 0, pending: 0, ms: 0, processesDown: n - got.length };
    for (const a of got) {
      sum.released += a.released ?? 0;
      sum.written += a.written ?? 0;
      sum.pending += a.pending ?? 0;
      sum.ms = Math.max(sum.ms, a.ms ?? 0);
    }
    return Response.json(sum);
  };

  // The router's own port can be taken (EADDRINUSE) after every child started: stop them before failing, as for a
  // child that could not start, so a failed start leaves no process behind.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = serveRouter();
  } catch (e) {
    await stopChildren();
    throw e;
  }

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? config.host,
    children,
    async stop() {
      draining = true;
      // Still serving while whoever sends here sees /readyz turn 503 (EDEN_DRAIN_DELAY_MS, D994).
      if ((config.drainDelayMs ?? 0) > 0) await Bun.sleep(config.drainDelayMs!);
      await Promise.race([server.stop(false), Bun.sleep(grace * 0.4)]);
      void server.stop(true);
      await stopChildren();
    },
  };

  function serveRouter() {
    return Bun.serve({
      port: config.port,
      hostname: config.host,
      // The same cap as each child's (D100): a chunked body past it is refused before it is buffered here.
      maxRequestBodySize: maxBodyBytes,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/readyz") {
          // The cluster router asks `?all=1`: ready only with every child up, since it moves a machine's users
          // elsewhere when it is not (D992), and a child that keeps failing to start is better served there than at
          // 503 here. Anyone else (Caddy, a container's health check) gets ready while any child is up (R1): one
          // child's crash must not take every user of the machine out, as /healthz says below.
          const up = children.filter((c) => c.up).length;
          const all = url.searchParams.get("all") === "1";
          if (!draining && (all ? up === n : up > 0)) return Response.json({ ready: true, processes: n, up });
          const error = draining ? "draining" : `${n - up} of ${n} processes down`;
          return Response.json({ ready: false, processes: n, up, error }, { status: 503 });
        }
        if (req.method === "GET" && url.pathname === "/metrics") return metricsEverywhere();
        if (url.pathname === "/internal/cluster") return clusterEverywhere(req);
        if (req.method === "GET" && url.pathname === "/healthz") {
          const up = children.filter((c) => c.up).length;
          if (up === n) return Response.json({ ok: true, processes: n, up });
          // Degraded, not down: 503 here would let a load balancer silence every user for one child's 1/N.
          const error = `${n - up} of ${n} processes down`;
          return Response.json({ ok: up > 0, processes: n, up, error }, { status: up > 0 ? 200 : 503 });
        }
        const tenant = tenantOf(req);
        // Only an authenticated POST is read for its user; anything else gets the child's own answer (405, 401).
        if (req.method !== "POST" || tenant === null)
          return forward(children[childFor(tenant ?? "", "", n)]!, req, url, undefined);
        // The child never sees the Origin header (only the key and content type are forwarded): a keyless request from
        // another site's page is refused here, as one process refuses it (http.ts, audit A20).
        if (tenant === "dev" && !keyOf(req) && !keylessOriginAllowed(req.headers.get("origin")))
          return fail(403, "dev mode serves no key-less request from another site's page");
        const waitMs = limiter.take(tenant);
        if (waitMs > 0) {
          return Response.json(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) } },
          );
        }
        if (Number(req.headers.get("content-length") ?? NaN) > maxBodyBytes) return fail(413, tooLarge);
        let body: Uint8Array;
        try {
          body = new Uint8Array(await req.arrayBuffer());
        } catch {
          return fail(400, "body could not be read");
        }
        const owner = children[childFor(tenant, userOf(body), n)]!;
        if (url.pathname === "/v1/forget") return forgetEverywhere(owner, req, url, body);
        if (url.pathname === "/v1/usage") return usageEverywhere(owner, req, url, body);
        return forward(owner, req, url, body);
      },
      // Nothing above should throw; if it does, the caller gets the server's 503, never Bun's default 500.
      error: () => fail(503, UNAVAILABLE),
    });
  }
}

/**
 * Children's `/v1/usage` answers summed (D326): every number added (nested records too, such as `requests` by route),
 * every other field taken from the first answer (tenant, day).
 */
export function sumUsage(parts: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "number") out[k] = ((out[k] as number | undefined) ?? 0) + v;
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = sumUsage([(out[k] as Record<string, unknown> | undefined) ?? {}, v as Record<string, unknown>]);
      } else if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

/** `main.ts` with EDEN_PROCESSES above 1: starts the router, stops the children on SIGINT/SIGTERM. */
export async function runRouter(config: ServerConfig): Promise<void> {
  const started = performance.now();
  // A failure to start (a busy port, a child that exited before listening, whose own message is already on stderr)
  // propagates to main.ts, which prints it as one `eden:` line and exits 2 (D365).
  const router = await startRouter({ config });
  const stop = () => void router.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(
    `eden router listening on http://${router.hostname}:${router.port}${config.dev ? " (dev, no auth)" : ""}` +
      ` (startup ${Math.round(performance.now() - started)} ms; ${config.processes} processes, users pinned by` +
      ` tenant/user; per-tenant caps divided by ${config.processes})`,
  );
}
