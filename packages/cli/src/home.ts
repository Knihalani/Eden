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
  chmodQuietly(h, 0o700);
  chmodQuietly(join(h, "runs"), 0o700);
  sweepRunsHome(h);
  return h;
}

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
        if (!existsSync(join(runsDir, `${base}.jsonl`))) rmQuietly(p);
      }
    }
  } catch {}
}

function rmQuietly(p: string): void {
  try {
    unlinkSync(p);
  } catch {}
}

function chmodQuietly(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {}
}

export function liveToolsPath(): string {
  return join(edenHome(), "live-tools.json");
}

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
  steer_hooks?: boolean;
  transparent_exec?: boolean;
  digest?: boolean;
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
  chmodQuietly(p, 0o600);
}

export function writeFileAtomic(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function appendJsonl(path: string, row: unknown): void {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1500;
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

function inodeAt(lockPath: string): number | null {
  try {
    return statSync(lockPath).ino;
  } catch {
    return null;
  }
}

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
      return fn();
    } finally {
      closeSync(fd);
      releaseLock(lockPath, ino);
    }
  }
  throw new Error(`could not acquire lock ${lockPath}`);
}

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

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function wrapPlaneUrl(raw?: string | null): string {
  const u = (raw || process.env.EDEN_WRAP_URL || process.env.EDEN_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "").replace(/\/v1\/?$/, "");
  return /127\.0\.0\.1:8787|localhost:8787/.test(u) ? u.replace(":8787", ":8788") : u;
}

export function wrapBase(cfg?: { base_url?: string } | null): string {
  return wrapPlaneUrl(process.env.EDEN_WRAP_URL || process.env.EDEN_BASE_URL || cfg?.base_url);
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
