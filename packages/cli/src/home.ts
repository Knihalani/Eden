import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

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
  writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

export function appendJsonl(path: string, row: unknown): void {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
