/**
 * A context window's own files (A4 §1 `<root>/windows/<win>/`), as far as P0.6 writes them:
 * - `delivery.log`: one `turn` record per human Submit (A4 §4). `hturn` is the count of distinct `prompt_id`s among
 *   them, so two racing Submits of one prompt count once (`humanTurns`, `memory-ledger.ts`, which folds the log and
 *   its snapshot). The ledger's `deliver`, `packet` and `epoch` records share the log.
 * - `delivery.shadow.log`: the same records from a point whose flag is `shadow` (X7), which delivers nothing. Turn
 *   records count from both logs, so `hturn` does not depend on which mode the Submits ran in.
 * - `ctx.log`: the prompt hashes of the window's last Stop `session_crons` (D24), never the prompts themselves; the
 *   `cwd` of its SessionStart, which names the repo of a session outside git (D1, `memory-repo.ts`); one `batch`
 *   record per PostToolBatch (`memory-batch.ts`); and a forked session's `fork` records (`memory-fork.ts`).
 *   `stop-sleep` compacts it (`compactContext`).
 * - `qprev.json`: the end of the agent's last message, written by `stop-fast` (A4 §5.7, A7 §3's `q_prev`) through the
 *   store's secret gate, as every text under the memory root is (A6 §2.2).
 * - `hwm.json`: the delta encoder's mark (`memory-delta.ts`).
 *
 * Each record is one appended line under 4 KB, so concurrent appends do not interleave.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../packages/cli/src/home";
import { memorySessionName } from "./index";
import { scrubMemoryText } from "./memory-scrub";
import type { BatchRecord } from "./memory-batch";
import type { FlagMode } from "./memory-flags";
import { promptHash } from "./memory-turn";

type WindowRecord = { k: string } & Record<string, unknown>;

const CONTEXT = "ctx.log";

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
  appendRecords(dir, file, [record]);
}

/** Appends records to a window file in one write, creating the window owner-only. */
export function appendRecords(dir: string, file: string, records: readonly WindowRecord[]): void {
  if (!records.length) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, file), records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
}

/**
 * The ledgers a window already has: one exists while its log, its snapshot or a rotated log of it does (a Stop folds
 * the log away into the snapshot, D25).
 */
export function existingLedgers(dir: string): LedgerFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: LedgerFile[] = [LIVE_LEDGER, SHADOW_LEDGER];
  return files.filter((file) => {
    const snapshot = file.replace(/\.log$/, ".json");
    const rotated = (name: string) => name.startsWith(`${file}.`) && /^\d+$/.test(name.slice(file.length + 1));
    return names.some((name) => name === file || name === snapshot || rotated(name));
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
  return parseRecords(text);
}

/** The records of a window file's text, one per line; a torn line is skipped. */
export function parseRecords(text: string): Record<string, unknown>[] {
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

/** The cron prompt hashes of the window's last Stop that carried `session_crons`. */
export function cronHashes(dir: string): string[] {
  const last = windowRecords(dir, CONTEXT).findLast((record) => record.k === "crons");
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
  appendRecord(dir, CONTEXT, { k: "crons", h: hashes });
}

/** The `cwd` of the window's SessionStart, when it recorded one. */
export function startCwd(dir: string): string | undefined {
  const last = windowRecords(dir, CONTEXT).findLast((record) => record.k === "start");
  return typeof last?.cwd === "string" ? last.cwd : undefined;
}

/** Records a SessionStart's `cwd` unless it is the one already recorded. */
export function recordStart(dir: string, cwd: string): void {
  if (startCwd(dir) !== cwd) appendRecord(dir, CONTEXT, { k: "start", cwd });
}

/**
 * A forked session's mark (`memory-fork.ts`): pending from its SessionStart, with when the parent last answered
 * (`last`, epoch ms) when the payload says; resolved once its parent was looked for (`from`, the parent's window name,
 * "" when none was found).
 */
export interface ForkMark {
  last?: number;
  from?: string;
}

/** The window's latest fork mark, if it was forked. */
export function forkMark(dir: string): ForkMark | undefined {
  const last = windowRecords(dir, CONTEXT).findLast((record) => record.k === "fork");
  if (!last) return undefined;
  return {
    ...(typeof last.last === "number" ? { last: last.last } : {}),
    ...(typeof last.from === "string" ? { from: last.from } : {}),
  };
}

/** Appends a fork mark. */
export function recordFork(dir: string, mark: ForkMark): void {
  appendRecord(dir, CONTEXT, { k: "fork", ...mark });
}

/** Appends a PostToolBatch's record (`memory-batch.ts`). */
export function recordBatch(dir: string, batch: BatchRecord): void {
  appendRecord(dir, CONTEXT, { k: "batch", ...batch });
}

/** `ctx.log` is folded over the last 3 human turns (A4 §1): older batches are dropped when it is compacted. */
const KEPT_TURNS = 3;
/** Below this size `ctx.log` is left as it is: compaction rewrites the file, which only an outgrown log needs. */
const COMPACT_BYTES = 32 * 1024;

/**
 * Compacts `ctx.log` at `stop-sleep` (A4 §1): the last `crons` and `start` records, and the batches of the last 3
 * human turns (by `prompt_id`). The file is replaced by rename; a batch appended meanwhile can be lost, which costs a
 * path signal, never a row.
 */
export function compactContext(dir: string): void {
  const size = statSync(join(dir, CONTEXT), { throwIfNoEntry: false })?.size ?? 0;
  if (size <= COMPACT_BYTES) return;
  const records = windowRecords(dir, CONTEXT);
  const turns = [...new Set(records.flatMap((record) => (record.k === "batch" ? [record.prompt_id] : [])))];
  const recent = new Set(turns.slice(-KEPT_TURNS));
  const kept = records.filter((record, at) =>
    record.k === "batch" ? recent.has(record.prompt_id) : records.findLastIndex((other) => other.k === record.k) === at,
  );
  writeFileAtomic(join(dir, CONTEXT), kept.map((record) => `${JSON.stringify(record)}\n`).join(""), 0o600);
}

/** The agent's last message as `stop-fast` saw it (`last_assistant_message`), and when. */
export interface LastAssistant {
  t: number;
  text: string;
}

const QPREV = "qprev.json";
/**
 * How much of the agent's last message `stop-fast` keeps: its end, where a proposal or question sits (A7 §2), and
 * small enough for the secret gate to fit its 15 ms budget (D34).
 */
const QPREV_CHARS = 8_000;
/**
 * What the secret gate reads before the kept end: past the reach of a keyword rule (D13: a keyword, up to 20
 * characters, a separator, then a value of up to 150), so a cut never separates a value from its keyword.
 */
const QPREV_GATE_MARGIN = 512;

/**
 * `stop-fast` (A4 §5.7): the end of the agent's last message, written by rename so a reader never sees half of it.
 * The secret gate (A6 §2.2) reads it first, with a margin before the kept part; the kept part then starts at a space,
 * so no token is split.
 */
export function writeLastAssistant(dir: string, last: LastAssistant): void {
  const gated = scrubMemoryText(last.text.slice(-(QPREV_CHARS + QPREV_GATE_MARGIN)));
  const end = gated.length > QPREV_CHARS ? gated.slice(-QPREV_CHARS).replace(/^\S*\s*/, "") : gated;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, QPREV), JSON.stringify({ t: last.t, text: end }), 0o600);
}

export function readLastAssistant(dir: string): LastAssistant | undefined {
  try {
    const last = JSON.parse(readFileSync(join(dir, QPREV), "utf8")) as Partial<LastAssistant>;
    return typeof last.t === "number" && typeof last.text === "string" ? { t: last.t, text: last.text } : undefined;
  } catch {
    return undefined;
  }
}
