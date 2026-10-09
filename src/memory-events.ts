/**
 * Wide events (EXECUTION §5 "Observability", X11): one JSON line per memory hook invocation, appended to
 * `<root>/hook.log.d/<yyyy-mm-dd>.jsonl` (UTC, by the memory clock). They hold ids, cids, counts, hashes, flag modes
 * and times; never prompt or row text. An error is logged as its class and the source line it was thrown from.
 *
 * Read them by point and by submit kind before comparing rates: non-human submits are most submits (R6).
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Flag, FlagMode } from "./memory-flags";

export const EVENTS_DIR = "hook.log.d";

/** The A4 §5.1 stages that drop notes between retrieval and the packet. */
export type DropStage = "validity" | "gate" | "residual" | "refractory" | "shape";

export interface WideEvent {
  /** Epoch ms, by the memory clock. */
  t: number;
  /** The hook event. */
  ev: string;
  /** The delivery point and its mode; absent at events that deliver nothing (Stop, PostToolUse, …). */
  point?: Flag;
  mode?: FlagMode;
  /** Every flag's mode; absent when the flags could not be read. */
  flags?: Record<Flag, FlagMode>;
  /** A hash of the repo top until P0.5 brings D1's repo key. */
  repo?: string;
  win?: string;
  hturn?: number;
  prompt_id?: string;
  prompt_hash?: string;
  submit?: "human" | "non-human";
  /** The D24 rule a non-human submit matched (`memory-turn.ts` `nonHumanKind`), and whether a preamble came first. */
  nonhuman?: string;
  preamble?: true;
  turn_mode?: string;
  /** The cids of the packet the point delivered, or in shadow would have. */
  cids?: string[];
  drops?: Partial<Record<DropStage, number>>;
  would_preempt?: string[];
  /** Milliseconds inside the hook's handler (process start and module load are not in it). */
  ms: number;
  /** A budget abort (A5 `abort_rate`). The hook has no budget abort yet (P4.2), so it is always false. */
  aborted: boolean;
  err?: string;
}

export function eventsDir(root: string): string {
  return join(root, EVENTS_DIR);
}

function dayFile(t: number): string {
  return `${new Date(t).toISOString().slice(0, 10)}.jsonl`;
}

/** Appends one event, creating the directory owner-only. A line stays under 4 KB, so appends do not interleave. */
export function appendWideEvent(root: string, event: WideEvent): void {
  const dir = eventsDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, dayFile(event.t)), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** An error as a wide event holds it: its class and where it was thrown, never its message (it may quote text). */
export function errorTag(err: unknown): string {
  const name = err instanceof Error ? err.name || "Error" : typeof err;
  const frame = err instanceof Error ? /\(?([^\s()]+):(\d+):\d+\)?/.exec(err.stack?.split("\n")[1] ?? "") : null;
  return frame ? `${name} at ${basename(frame[1]!)}:${frame[2]}` : name;
}

/** The newest `n` events of a point, oldest first, reading day files newest first until it has them. */
export function recentEvents(root: string, point: Flag, n: number): WideEvent[] {
  let days: string[] = [];
  try {
    days = readdirSync(eventsDir(root))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: WideEvent[] = [];
  for (const day of days) {
    let text = "";
    try {
      text = readFileSync(join(eventsDir(root), day), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as WideEvent;
        if (event?.point === point) out.push(event);
      } catch {}
      if (out.length >= n) return out.reverse();
    }
  }
  return out.reverse();
}
