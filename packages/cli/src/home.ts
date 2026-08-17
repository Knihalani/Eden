import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";

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

export function eventsPath(runId: string): string {
  return join(edenHome(), "runs", `${runId}.jsonl`);
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

export function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    try {
      const fd = openSync(lockPath, "wx");
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
    } catch {
      try {
        Bun.sleepSync(8);
      } catch {
        const end = Date.now() + 8;
        while (Date.now() < end) {
          /* wait for lock */
        }
      }
    }
  }
  throw new Error(`could not acquire lock ${lockPath}`);
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
