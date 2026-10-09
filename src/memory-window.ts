/**
 * A context window's own files (A4 §1 `<root>/windows/<win>/`), as far as P0.2 writes them:
 * - `delivery.log`: one `turn` record per human Submit (A4 §4). `hturn` is the count of distinct `prompt_id`s among
 *   them, so two racing Submits of one prompt count once. The ledger's `deliver` and `epoch` records share the log
 *   (`memory-ledger.ts`).
 * - `delivery.shadow.log`: the same records from a point whose flag is `shadow` (X7), which delivers nothing. Turn
 *   records count from both logs, so `hturn` does not depend on which mode the Submits ran in.
 * - `ctx.log`: the prompt hashes of the window's last Stop `session_crons` (D24), never the prompts themselves.
 *
 * Each record is one appended line under 4 KB, so concurrent appends do not interleave.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { memorySessionName } from "./index";
import type { FlagMode } from "./memory-flags";
import { promptHash } from "./memory-turn";

type WindowRecord = { k: string } & Record<string, unknown>;

export const LIVE_LEDGER = "delivery.log";
export const SHADOW_LEDGER = "delivery.shadow.log";
export type LedgerFile = typeof LIVE_LEDGER | typeof SHADOW_LEDGER;

/** The ledger a point writes in a mode: none when it is `off` (X7: no ledger write). */
export function ledgerFor(mode: FlagMode): LedgerFile | undefined {
  return mode === "on" ? LIVE_LEDGER : mode === "shadow" ? SHADOW_LEDGER : undefined;
}

/** The window directory of a session (D2: `session_id`, or `session_id--agent_id` in a subagent). */
export function windowDir(root: string, win: string): string | undefined {
  const name = memorySessionName(win);
  return name ? join(root, "windows", name) : undefined;
}

/** Appends one record to a window file, creating the window owner-only. */
export function appendRecord(dir: string, file: string, record: WindowRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, file), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** The ledger files a window already has. */
export function existingLedgers(dir: string): LedgerFile[] {
  const files: LedgerFile[] = [LIVE_LEDGER, SHADOW_LEDGER];
  return files.filter((file) => {
    try {
      return statSync(join(dir, file)).isFile();
    } catch {
      return false;
    }
  });
}

/** A window file's records; a torn line is skipped and a missing file has none. */
export function windowRecords(dir: string, file: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = readFileSync(join(dir, file), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const record: unknown = JSON.parse(line);
      return record && typeof record === "object" ? [record as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** The transcript's size in bytes: the offset a record is made at. 0 when there is none. */
export function transcriptOffset(path: string): number {
  try {
    return path ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

/** Appends the turn record of a human Submit. Without a `prompt_id` (before v2.1.196), the prompt and offset key it. */
export function appendTurn(
  dir: string,
  turn: { promptId?: string; prompt: string; off: number },
  file: LedgerFile = LIVE_LEDGER,
): void {
  const promptId = turn.promptId || `${promptHash(turn.prompt)}@${turn.off}`;
  appendRecord(dir, file, { k: "turn", prompt_id: promptId, off: turn.off });
}

/** `hturn` (A4 §4): the number of human turns this window has seen, in either ledger. */
export function humanTurns(dir: string): number {
  const ids = [LIVE_LEDGER, SHADOW_LEDGER].flatMap((file) =>
    windowRecords(dir, file).flatMap((record) => (record.k === "turn" ? [record.prompt_id] : [])),
  );
  return new Set(ids).size;
}

/** The cron prompt hashes of the window's last Stop that carried `session_crons`. */
export function cronHashes(dir: string): string[] {
  const last = windowRecords(dir, "ctx.log").findLast((record) => record.k === "crons");
  return Array.isArray(last?.h) ? last.h.filter((hash): hash is string => typeof hash === "string") : [];
}

/** Keeps the crons a Stop reports, appending only when they differ from the last ones kept. */
export function recordCrons(dir: string, sessionCrons: unknown): void {
  if (!Array.isArray(sessionCrons)) return;
  const prompts = sessionCrons.flatMap((cron) => {
    const prompt = (cron as { prompt?: unknown } | null)?.prompt;
    return typeof prompt === "string" && prompt.trim() ? [promptHash(prompt)] : [];
  });
  const hashes = [...new Set(prompts)].sort();
  if (hashes.join() === cronHashes(dir).join()) return;
  appendRecord(dir, "ctx.log", { k: "crons", h: hashes });
}
