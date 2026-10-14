/**
 * Wide events (EXECUTION §5 "Observability", X11): one JSON line per memory hook invocation, appended to
 * `<root>/hook.log.d/<yyyy-mm-dd>.jsonl` (UTC, by the memory clock). They hold ids, cids, counts, hashes, flag modes
 * and times; never prompt or row text. An error is logged as its class and the source line it was thrown from.
 *
 * Read them by point and by submit kind before comparing rates: non-human submits are most submits (R6).
 *
 * Retention (X11): a day file is kept 90 days, then replaced by its daily aggregate, `daily/<yyyy-mm-dd>.json`:
 * per event, point and submit kind, the count, packets, cids, drops by stage, `ms` quantiles, aborts and errors.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import type { Flag, FlagMode } from "./memory-flags";

export const EVENTS_DIR = "hook.log.d";

/** The A4 §5.1 stages that drop notes between retrieval and the packet; `budget` is A4 §4's epoch cap. */
export type DropStage = "validity" | "gate" | "residual" | "refractory" | "budget" | "shape";

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
  /** The action classes a human prompt's own words fire (A7 §5): what its compiled triggers deliver from. */
  classes?: string[];
  /**
   * D9, D11 at a human Submit: the rules of the prompt an earlier session also stated (A4 §7's `policy_recur`), and
   * the rules it kept for all projects (`kept`: a confirmed proposal, D11's phrases) or ended there (`dropped`).
   */
  policy_recur?: string[];
  kept?: string[];
  dropped?: string[];
  /** The proposal for all projects a SessionStart showed (D11), by `ruleIdentity`. */
  proposed?: string;
  /** The rules a SessionStart proposed revoking (A6 §2.5: declined 3 times in 14 days), by `ruleIdentity`. */
  revoke?: string[];
  /**
   * SubagentStart (A4 §5.3): where the child's scope came from (its launch's record, the parent's recent paths, or
   * the scope it stored at its first start), and how many paths it holds. `PreToolUse(Agent)`: the launch it recorded.
   */
  scope?: "task" | "parent" | "stored";
  paths?: number;
  /** The scope count of the catalog this event rebuilt (D3): after a batch's manifest write, or at a turn's end. */
  catalog?: number;
  /** How many scopes the read set of a human Submit or a SubagentStart holds (D4, `memory-place.ts`): 1 or 2. */
  read?: number;
  /**
   * D31: how many folders a FileChanged read again, and how many files a SessionStart, CwdChanged or FileChanged
   * named to watch.
   */
  recheck?: number;
  watch?: number;
  spawn?: { type: string; paths: number; classes: string[] };
  /** The cids of the packet the point delivered, or in shadow would have, and the ids of their rows. */
  cids?: string[];
  ids?: string[];
  /** The transcript's size at a Submit (the ledger's `off`), and the context tokens of its last `message.usage`. */
  off?: number;
  ctx_tokens?: number;
  /** The tokens delivered in this epoch before the packet (A4 §4's budget). */
  tokens_epoch?: number;
  drops?: Partial<Record<DropStage, number>>;
  would_preempt?: string[];
  /** Which of Stop's two handlers ran (D34). */
  stage?: "stop-fast" | "stop-sleep";
  /** Texts the delta encoder read from the transcript (A4 §3.3), and the turns a rewind abandoned. */
  encoded?: number;
  abandoned?: number;
  /** PostCompact (A4 §4): the cids `compact_summary` held, and how many of the closed epoch's it left re-armed. */
  held?: string[];
  rearmed?: number;
  /**
   * The PreToolUse guard (D19, A4 §5.4): its class, the call, and what it did: an ask was due (`would_ask`, X7's
   * shadow measure), it asked (`asked`), the permission mode turned it to context (`guard_bypassed`), or another
   * handler of the call answered (`guard_dup`). PostToolBatch labels asks it sees answered (A6 §2.5).
   */
  guard_class?: string;
  tool_use_id?: string;
  would_ask?: true;
  asked?: true;
  guard_bypassed?: true;
  guard_dup?: true;
  guard_labels?: { id: string; label: string }[];
  /** A fork's copy of its parent's ledger (D25): the parent's window ("" when none was found), and its deliveries. */
  forked_from?: string;
  copied?: number;
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
        // The wrap's events (`ev: "wrap"`) share `deliver.submit` but are not the hook's invocations.
        if (event?.point === point && event.ev !== "wrap") out.push(event);
      } catch {}
      if (out.length >= n) return out.reverse();
    }
  }
  return out.reverse();
}

/** X11: how long a day file is kept before it becomes a daily aggregate. */
const RETAIN_DAYS = 90;
const DAY_MS = 86_400_000;
const DAILY_DIR = "daily";

/** One group of a day's events (see the header). */
interface DailyGroup {
  ev: string;
  point?: Flag;
  submit?: WideEvent["submit"];
  n: number;
  packets: number;
  cids: number;
  drops: Partial<Record<DropStage, number>>;
  ms: { p50: number; p99: number; max: number };
  aborted: number;
  errors: number;
}

function nearestRank(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

/** A day's events as aggregates: counts and times only, no ids or hashes. */
function aggregate(events: readonly WideEvent[]): DailyGroup[] {
  const groups = new Map<string, { group: DailyGroup; ms: number[] }>();
  for (const event of events) {
    const key = [event.ev, event.point ?? "", event.submit ?? ""].join("|");
    let entry = groups.get(key);
    if (!entry) {
      const group: DailyGroup = {
        ev: event.ev,
        ...(event.point ? { point: event.point } : {}),
        ...(event.submit ? { submit: event.submit } : {}),
        n: 0,
        packets: 0,
        cids: 0,
        drops: {},
        ms: { p50: 0, p99: 0, max: 0 },
        aborted: 0,
        errors: 0,
      };
      groups.set(key, (entry = { group, ms: [] }));
    }
    const { group } = entry;
    group.n++;
    if (event.cids?.length) group.packets++;
    group.cids += event.cids?.length ?? 0;
    for (const [stage, count] of Object.entries(event.drops ?? {}) as [DropStage, number][])
      if (count) group.drops[stage] = (group.drops[stage] ?? 0) + count;
    if (event.aborted) group.aborted++;
    if (event.err) group.errors++;
    if (typeof event.ms === "number") entry.ms.push(event.ms);
  }
  return [...groups.values()].map(({ group, ms }) => {
    const sorted = ms.sort((a, b) => a - b);
    return { ...group, ms: { p50: nearestRank(sorted, 0.5), p99: nearestRank(sorted, 0.99), max: sorted.at(-1) ?? 0 } };
  });
}

function parseEvents(text: string): WideEvent[] {
  return text.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line) as WideEvent;
      return event && typeof event === "object" && typeof event.ev === "string" ? [event] : [];
    } catch {
      return [];
    }
  });
}

/**
 * X11's retention (see the header), run at `stop-sleep`: each day file older than 90 days (by the memory clock) is
 * written as its aggregate, by rename, then removed. Under a lock taken without waiting: another hook doing it leaves
 * nothing to do. Fails open.
 */
export function retainEvents(root: string, now: number): void {
  const dir = eventsDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = new Date(now - RETAIN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const expired = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff);
  if (!expired.length) return;
  try {
    withFileLock(
      join(dir, ".retain.lock"),
      () => {
        mkdirSync(join(dir, DAILY_DIR), { recursive: true, mode: 0o700 });
        for (const name of expired) {
          const day = name.slice(0, 10);
          let text: string;
          try {
            text = readFileSync(join(dir, name), "utf8");
          } catch {
            continue;
          }
          const events = parseEvents(text);
          const body = JSON.stringify({ day, events: events.length, groups: aggregate(events) });
          writeFileAtomic(join(dir, DAILY_DIR, `${day}.json`), body, 0o600);
          rmSync(join(dir, name), { force: true });
        }
      },
      0,
    );
  } catch {}
}
