/**
 * A window's `guard.log` (A4 §1, §5.4–5.5; A6 §2.5): one `call` line per tool call the guard answered, appended by the
 * first of its parallel handlers under `flock(guard.lock)`, so the others stay silent; and one `label` line per ask
 * whose answer a later PostToolBatch read from the call's result. Lines hold ids, classes and rule keys only (X11).
 *
 * - **approved:** the call ran: its result is neither a refusal nor a failure to start.
 * - **declined:** its result is Claude Code's permission-rejection message (the user said no).
 * - **denied:** its result says permission was denied without the user being asked (`-p` with no permission host,
 *   or a classifier): not the user's answer, so it never counts as a decline.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../packages/cli/src/home";
import { resultText } from "./memory-batch";
import { memoryNow } from "./memory-clock";

export const GUARD_LOG = "guard.log";
const GUARD_LOCK = "guard.lock";
/** How much of `guard.log` is read: parallel handlers of one call append within milliseconds of each other. */
const GUARD_TAIL_BYTES = 16 * 1024;

export type GuardLabel = "approved" | "declined" | "denied";

export type GuardCallRecord = {
  k: "call";
  t: number;
  /** The call's `tool_use_id`. */
  id: string;
  cls: string;
  /** The rules shown, by `ruleIdentity`. */
  rules: string[];
  /** An ask was due; it was returned. */
  due: boolean;
  ask: boolean;
  /** The permission mode of the call. */
  mode: string;
};

export type GuardRecord = GuardCallRecord | { k: "label"; t: number; id: string; label: GuardLabel };

/** The last `GUARD_TAIL_BYTES` of a window's `guard.log`, parsed; none when it cannot be read. */
export function guardRecords(win: string): GuardRecord[] {
  let text = "";
  try {
    const fd = openSync(join(win, GUARD_LOG), "r");
    try {
      const size = fstatSync(fd).size;
      const from = Math.max(0, size - GUARD_TAIL_BYTES);
      const buffer = Buffer.alloc(size - from);
      readSync(fd, buffer, 0, buffer.length, from);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line) as GuardRecord;
      return record && typeof record.id === "string" && (record.k === "call" || record.k === "label") ? [record] : [];
    } catch {
      return [];
    }
  });
}

/** Appends records to a window's `guard.log`, owner-only; each line is under 4 KB, so appends do not interleave. */
function appendGuardRecords(win: string, records: readonly GuardRecord[]): void {
  if (!records.length) return;
  mkdirSync(win, { recursive: true, mode: 0o700 });
  const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  appendFileSync(join(win, GUARD_LOG), lines, { mode: 0o600 });
}

/** Whether this handler is the first to answer its call; if so, the call is recorded (see the header). */
export function claimCall(win: string, record: GuardCallRecord): boolean {
  mkdirSync(win, { recursive: true, mode: 0o700 });
  return withFileLock(join(win, GUARD_LOCK), () => {
    if (record.id && guardRecords(win).some((known) => known.k === "call" && known.id === record.id)) return false;
    appendGuardRecords(win, [record]);
    return true;
  });
}

const DECLINED = /^The user doesn't want to proceed with this tool use\b/;
const DENIED = /^Permission to use \S+.*\bhas been denied\b|^Permission to use \S+ was denied\b/;

/** What a call's result says of its ask (see the header). */
export function labelOf(response: unknown): GuardLabel {
  const text = resultText(response).trim();
  return DECLINED.test(text) ? "declined" : DENIED.test(text) ? "denied" : "approved";
}

type BatchCall = { tool_use_id?: unknown; tool_response?: unknown };

/** Labels the asks of this window that a batch's calls answered (A4 §5.5), once each; returns the labels. */
export function labelGuardCalls(win: string, calls: readonly BatchCall[]): { id: string; label: GuardLabel }[] {
  const records = guardRecords(win);
  const labelled = new Set(records.flatMap((record) => (record.k === "label" ? [record.id] : [])));
  const asked = new Set(records.flatMap((record) => (record.k === "call" && record.ask ? [record.id] : [])));
  const labels = calls.flatMap((call) => {
    const id = typeof call.tool_use_id === "string" ? call.tool_use_id : "";
    return id && asked.has(id) && !labelled.has(id) ? [{ id, label: labelOf(call.tool_response) }] : [];
  });
  const t = memoryNow();
  appendGuardRecords(
    win,
    labels.map(({ id, label }) => ({ k: "label" as const, t, id, label })),
  );
  return labels;
}

/** Whether a call's result shows it ran: no refusal, and no `Exit code N` other than 0 (`memory-batch.ts`). */
export function ran(response: unknown): boolean {
  const text = resultText(response).trim();
  return labelOf(response) === "approved" && !/^Exit code [1-9]\d*\b/.test(text) && !/^PreToolUse:\S+ hook/.test(text);
}

/** The rules the guard last showed in this window (by `ruleIdentity`): what "that rule" names. */
export function lastShownRules(win: string): string[] {
  return guardRecords(win).findLast((record): record is GuardCallRecord => record.k === "call")?.rules ?? [];
}
