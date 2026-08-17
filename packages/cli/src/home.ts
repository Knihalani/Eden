import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";

export function edenHome(): string {
  return process.env.EDEN_HOME || join(homedir(), ".eden");
}

export function ensureHome(): string {
  const h = edenHome();
  mkdirSync(join(h, "runs"), { recursive: true });
  return h;
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
};

export function readConfig(): Config | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeConfig(c: Config): void {
  ensureHome();
  writeFileSync(configPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function appendJsonl(path: string, row: unknown): void {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/** A lock older than this belonged to a process that is not coming back. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1500;

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
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const t0 = Date.now();
  while (Date.now() - t0 < LOCK_WAIT_MS) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      // Held, or abandoned. Break an abandoned one rather than spin on it.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        /* raced with the holder releasing it; just retry */
      }
      sleepBriefly();
      continue;
    }
    // Outside the acquisition try/catch: whatever fn() throws is the caller's
    // error and propagates unchanged, exactly once.
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error(`could not acquire lock ${lockPath}`);
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
