/**
 * The plugin's record of why it could not run Eden: one line per distinct cause in
 * `$EDEN_HOME/plugin-fallback.jsonl`, so a broken install is visible (`eden doctor --memory`) without a line per
 * hook. Causes are error messages (paths and module names); no prompt text is ever written.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const FALLBACK_LOG = "plugin-fallback.jsonl";

export type Fallback = { t: string; plugin: string; cause: string };

export function fallbackLogPath(edenHome = process.env.EDEN_HOME || join(homedir(), ".eden")): string {
  return join(edenHome, FALLBACK_LOG);
}

/** Every logged cause, oldest first; a torn or missing log reads as none. */
export function readFallbacks(path = fallbackLogPath()): Fallback[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Fallback[] = [];
  for (const line of text.split("\n")) {
    try {
      const f = JSON.parse(line) as Partial<Fallback>;
      if (typeof f.t === "string" && typeof f.plugin === "string" && typeof f.cause === "string") {
        out.push({ t: f.t, plugin: f.plugin, cause: f.cause });
      }
    } catch {}
  }
  return out;
}

/**
 * Appends the cause unless this plugin already logged it. Two hooks that fail at the same moment may both append it;
 * readers count distinct causes.
 */
export function logFallbackOnce(plugin: string, cause: string, path = fallbackLogPath()): void {
  if (readFallbacks(path).some((f) => f.plugin === plugin && f.cause === cause)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line: Fallback = { t: new Date().toISOString(), plugin, cause };
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}
