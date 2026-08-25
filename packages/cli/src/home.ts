import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync, readdirSync, writeSync, fstatSync, renameSync, chmodSync } from "node:fs";

export function edenHome(): string {
  return process.env.EDEN_HOME || join(homedir(), ".eden");
}

export function ensureHome(): string {
  const h = edenHome();
  mkdirSync(join(h, "runs"), { recursive: true });
  // ~/.eden holds the API key and the full recorded tool traces of every
  // session. mkdir's mode is masked by the process umask and is not applied at
  // all to a directory that already exists, so the permissions are set
  // explicitly rather than requested.
  chmodQuietly(h, 0o700);
  chmodQuietly(join(h, "runs"), 0o700);
  sweepRunsHome(h);
  return h;
}

/**
 * Retention for ~/.eden/runs: un-uploaded session logs used to grow forever
 * when the plane stayed down, and drained sessions left empty .jsonl shells
 * and .lock/.cursor sidecars behind permanently.
 *
 * Swept here (every ensureHome — every CLI entry point) rather than in drain,
 * because drain is exactly the thing that is DOWN when files accumulate.
 * Best-effort by construction: any failure to sweep must never fail the
 * command that called ensureHome.
 *
 * Policy:
 *   - delete empty .jsonl shells older than an hour (a fresh file may be
 *     mid-session with nothing written yet)
 *   - delete orphaned sidecars (.lock/.cursor) whose log is gone or stale
 *   - delete non-empty logs older than RETAIN_DAYS (default 14) — recording
 *     exists to be uploaded; two-week-old un-uploaded runs are dead weight
 */
function sweepRunsHome(h: string): void {
  try {
    const runsDir = join(h, "runs");
    const now = Date.now();
    const EMPTY_SHELL_MS = 60 * 60_000;
    const retainDays = Number(process.env.EDEN_RETAIN_DAYS);
    const RETAIN_MS = (Number.isFinite(retainDays) && retainDays > 0 ? retainDays : 14) * 86_400_000;
    for (const f of readdirSync(runsDir)) {
      if (!f.endsWith(".jsonl") && !f.endsWith(".lock") && !f.endsWith(".cursor")) continue;
      const p = join(runsDir, f);
      let st: { size: number; mtimeMs: number };
      try {
        st = statSync(p);
      } catch {
        continue; // raced away
      }
      const age = now - st.mtimeMs;
      const base = f.replace(/\.(jsonl|lock|cursor)$/, "");
      if (f.endsWith(".jsonl")) {
        if ((st.size === 0 && age > EMPTY_SHELL_MS) || age > RETAIN_MS) {
          rmQuietly(p);
          rmQuietly(join(runsDir, `${base}.lock`));
          rmQuietly(join(runsDir, `${base}.cursor`));
        }
      } else {
        // Sidecar without its log: pure garbage.
        if (!existsSync(join(runsDir, `${base}.jsonl`))) rmQuietly(p);
      }
    }
  } catch {
    /* sweeping must never break the command that ran ensureHome */
  }
}

function rmQuietly(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* gone already, or locked this instant — either is fine */
  }
}

function chmodQuietly(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* a filesystem without POSIX modes, or not ours to change */
  }
}

export function liveToolsPath(): string {
  return join(edenHome(), "live-tools.json");
}

/**
 * A session/run id is only ever used to name a file, so it must not be able to
 * name a *different* file. `session_id` arrives from the hook payload, which
 * hookd accepts unauthenticated over HTTP, and it used to be interpolated
 * straight into a path: `../../../foo` reached anything on disk. Combined with
 * drain, which uploads and then unlinks whatever the id points at, that meant a
 * remote caller could exfiltrate and delete arbitrary .jsonl files — including
 * the Claude Code transcripts under ~/.claude/projects.
 *
 * Anything outside the allowlist is folded to a stable hashed name rather than
 * rejected, so a host that uses unusual session ids still records events
 * instead of silently losing them.
 */
export function safeRunId(runId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(runId)) return runId;
  return `sess_${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

export function eventsPath(runId: string): string {
  return join(edenHome(), "runs", `${safeRunId(runId)}.jsonl`);
}

export function outboxPath(): string {
  return join(edenHome(), "outbox.jsonl");
}

export function configPath(): string {
  return join(edenHome(), "config.json");
}

export type Config = {
  api_key: string;
  base_url: string;
  workspace_id?: string;
  /**
   * Opt-in hook steering. Default OFF — the prime directive is that a broken
   * or half-set-up Eden never denies one of the agent's own tool calls. When
   * true, a PreToolUse whose call matches a live compiled tool is pointed at
   * the MCP tool instead.
   */
  steer_hooks?: boolean;
};

export function readConfig(): Config | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeConfig(c: Config): void {
  ensureHome();
  const p = configPath();
  writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  // `mode` on writeFileSync applies only when the file is *created*. Rewriting
  // an existing config left whatever mode it already had, so a config.json
  // that had once been written without the flag — or created by an editor,
  // or restored from a backup — kept its 0644 and the API key stayed
  // world-readable however many times setup ran.
  chmodQuietly(p, 0o600);
}

/**
 * Replace a file's contents without a window in which it is half-written.
 *
 * writeFileSync truncates first and writes second, so a crash, a full disk or
 * a power loss in between leaves the file empty or ending in a partial line —
 * and every file this module manages is JSONL that a reader has to parse.
 * Writing a sibling temp file and renaming makes the swap atomic: a reader
 * sees the old contents or the new ones, never a mixture.
 */
export function writeFileAtomic(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

export function appendJsonl(path: string, row: unknown): void {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/**
 * Fallback staleness horizon, used only when the lock does not say who holds
 * it (a legacy lock, or one caught between create and stamp) or when it is
 * held from a different machine. A live local holder is detected directly and
 * is never judged stale, however long it has been running.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1500;
/**
 * Backstop for a stamp that claims to be alive.
 *
 * `kill(pid, 0)` answers "is this pid addressable", not "is this the process
 * that took the lock". After a reboot or enough process churn the pid can
 * belong to something else entirely, and EPERM — a pid owned by another user —
 * also reads as alive. Without an upper bound those cases wedge the lock
 * permanently, because the staleness horizon is never consulted for a stamped
 * lock. Nothing legitimately holds one of these for ten minutes: every
 * critical section here is a small file rewrite.
 */
const LOCK_ABANDON_MS = 600_000;

type LockStamp = { pid: number; host: string; ts: number };

function readLockStamp(lockPath: string): LockStamp | null {
  try {
    const s = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockStamp>;
    if (typeof s?.pid === "number" && typeof s?.host === "string") {
      return { pid: s.pid, host: s.host, ts: Number(s.ts) || 0 };
    }
  } catch {
    /* absent, empty, half-written, or a pre-stamp lock: fall back to age */
  }
  return null;
}

/**
 * Is the process named by the lock still around?
 *
 * `kill(pid, 0)` sends no signal, it only asks whether the pid is addressable.
 * EPERM means the process exists but belongs to another user, which still
 * counts as alive. A stamp from another host cannot be judged this way, so it
 * is reported as unknown and the caller falls back to the age horizon.
 */
function holderState(stamp: LockStamp | null): "alive" | "dead" | "unknown" {
  if (!stamp) return "unknown";
  if (stamp.host !== hostname()) return "unknown";
  if (!Number.isInteger(stamp.pid) || stamp.pid <= 0) return "unknown";
  try {
    process.kill(stamp.pid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" ? "alive" : "dead";
  }
}

/** Identity of the file currently at `lockPath`, or null if it is gone. */
function inodeAt(lockPath: string): number | null {
  try {
    return statSync(lockPath).ino;
  } catch {
    return null;
  }
}

/**
 * Advisory lock around a small file mutation.
 *
 * Two things this has to get right, both learned the hard way:
 *
 *  - The lock file is removed in a `finally`, which does not run for SIGKILL,
 *    a panic, or a reset. Without staleness detection one dead process wedged
 *    every later hook: 1.5s of spinning and then a throw, on every tool call,
 *    until someone deleted the file by hand.
 *  - The callback's own failure must not be reported as lock contention. The
 *    single try/catch could not tell `openSync` failing from `fn()` failing, so
 *    a real error (ENOSPC, a JSON throw) was swallowed, the caller was told
 *    "could not acquire lock", and the side-effecting callback was retried
 *    ~124 times over the wait window.
 *  - Staleness had been judged purely on the lock's age, which broke mutual
 *    exclusion outright. A holder only has to be *stopped* for longer than the
 *    horizon, not dead — a suspended laptop, SIGSTOP under a debugger, a
 *    swapping machine or a hung network mount all qualify. The waiter deleted a
 *    live holder's lock, took its own, and both ran the critical section at
 *    once; then the original holder's `finally` deleted the *waiter's* lock,
 *    letting a third process in, and so on. Two concurrent
 *    read-modify-writes of the same events file lose events, which is the one
 *    thing this lock exists to prevent. So the holder now stamps its identity
 *    into the lock and a live local holder is never broken, and release only
 *    removes the lock if it is still the one we created.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const t0 = Date.now();
  while (Date.now() - t0 < LOCK_WAIT_MS) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      breakIfAbandoned(lockPath);
      sleepBriefly();
      continue;
    }
    // Stamp who we are so a contender can tell "still running" from "died
    // holding it". Best effort: an unstamped lock is simply judged on age, as
    // it was before, so a failure here degrades rather than breaks.
    // Identity first and on its own: fstat of a descriptor we just opened is
    // the one part that cannot realistically fail, and release depends on it.
    let ino: number | null = null;
    try {
      ino = fstatSync(fd).ino;
    } catch {
      /* no provable identity; release falls back to an unconditional unlink */
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() } satisfies LockStamp));
    } catch {
      /* unstamped: contenders fall back to the age horizon */
    }
    // Outside the acquisition try/catch: whatever fn() throws is the caller's
    // error and propagates unchanged, exactly once.
    try {
      return fn();
    } finally {
      closeSync(fd);
      releaseLock(lockPath, ino);
    }
  }
  throw new Error(`could not acquire lock ${lockPath}`);
}

/**
 * Async twin of {@link withFileLock} for long-lived processes.
 *
 * The acquisition loop is byte-for-byte the same policy — stamped locks,
 * abandonment, inode-checked release — with one difference: it waits with
 * `await Bun.sleep(8)` instead of `Bun.sleepSync(8)`. `sleepSync` parks the
 * *entire event loop*, so in hookd's long-lived process one contended lock
 * stalled every other session's request for the whole wait window. One-shot
 * hook processes keep the sync {@link withFileLock}: they have nothing else to
 * serve and pay no cost for spinning.
 */
export async function withFileLockAsync<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const t0 = Date.now();
  while (Date.now() - t0 < LOCK_WAIT_MS) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      breakIfAbandoned(lockPath);
      await Bun.sleep(8);
      continue;
    }
    // Stamp who we are so a contender can tell "still running" from "died
    // holding it" — same best-effort stamp as withFileLock.
    let ino: number | null = null;
    try {
      ino = fstatSync(fd).ino;
    } catch {
      /* no provable identity; release falls back to an unconditional unlink */
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() } satisfies LockStamp));
    } catch {
      /* unstamped: contenders fall back to the age horizon */
    }
    try {
      return await fn();
    } finally {
      closeSync(fd);
      releaseLock(lockPath, ino);
    }
  }
  throw new Error(`could not acquire lock ${lockPath}`);
}

/**
 * Remove a lock that its holder can no longer release.
 *
 * Only three things justify deleting a lock we do not hold: the process that
 * stamped it is gone, the lock is unattributable and older than the horizon, or
 * it is so old that whatever the stamp says, nobody is coming back for it. A
 * live local holder is otherwise left alone however long it has been in there.
 *
 * The abandonment decision and the unlink are two syscalls apart, and in
 * between the holder may release and a third process may acquire. Deleting
 * then would evict a live holder — the very failure this function exists to
 * avoid — so the inode observed when the decision was made is captured and
 * compared before unlinking. Checking merely that *a* file is still there is
 * not the same test: a replacement lock is also a file.
 */
function breakIfAbandoned(lockPath: string): void {
  try {
    const before = inodeAt(lockPath);
    if (before === null) return;
    const stamp = readLockStamp(lockPath);
    const state = holderState(stamp);
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (state === "alive" && age <= LOCK_ABANDON_MS) return;
    if (state === "unknown" && age <= LOCK_STALE_MS) return;
    if (inodeAt(lockPath) !== before) return;
    unlinkSync(lockPath);
  } catch {
    /* raced with the holder releasing it, or not ours to remove; just retry */
  }
}

/**
 * Release only our own lock.
 *
 * If a contender already judged this lock abandoned and replaced it, the file
 * sitting at `lockPath` belongs to that contender and deleting it would let a
 * third process in behind their back. In the rare case where we never got an
 * inode to compare against, an unconditional unlink is still better than
 * leaving the lock wedged for the whole staleness horizon.
 */
function releaseLock(lockPath: string, ino: number | null): void {
  try {
    if (ino !== null && inodeAt(lockPath) !== ino) return;
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

function sleepBriefly(): void {
  try {
    Bun.sleepSync(8);
  } catch {
    const end = Date.now() + 8;
    while (Date.now() < end) {
      /* wait for lock */
    }
  }
}

/**
 * Non-reversible stand-in for an API key in human-facing output.
 *
 * doctor and login used to print the first 6–8 characters of the key itself,
 * which is exactly the part of a bearer token that carries its prefix and
 * narrows a brute force. A SHA-256 fingerprint identifies *which* key this is
 * ("is that the dev key or the prod one?") without disclosing any of it.
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function wrapPlaneUrl(raw?: string | null): string {
  const u = (raw || process.env.EDEN_WRAP_URL || process.env.EDEN_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "").replace(/\/v1\/?$/, "");
  return /127\.0\.0\.1:8787|localhost:8787/.test(u) ? u.replace(":8787", ":8788") : u;
}

export function sitePlaneUrl(raw?: string | null): string {
  const u = (raw || process.env.EDEN_SITE_URL || process.env.EDEN_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  return /127\.0\.0\.1:8788|localhost:8788/.test(u) ? u.replace(":8788", ":8787") : u;
}

export function resolveApiKey(args: string[] = []): string {
  const i = args.indexOf("--key");
  const flagged = i >= 0 ? args[i + 1] : undefined;
  const explicit = flagged || process.env.EDEN_API_KEY;
  if (explicit) return explicit;
  const cfg = readConfig();
  if (cfg?.api_key) return cfg.api_key;
  if (args.includes("--dev") || process.env.EDEN_DEV === "1") return "eden_dev";
  throw new Error("eden needs --key, EDEN_API_KEY, eden login, or --dev");
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
