/**
 * A forked session copies its parent's ledger (D25; A4 §4: "`fork` (session or fork subagent): copy the parent
 * ledger"), since it starts with the parent's context, Eden's packets included.
 *
 * Claude Code (2.1.294, captured 2026-10-10) gives a fork (`--fork-session`, `/fork`, `/branch`) a new session id.
 * Its SessionStart (`source: "fork"`) names no parent, and its transcript, the parent's lines with their `uuid`s kept
 * and each `promptId` replaced by the fork's, is written only after the fork's first turn. So:
 * - SessionStart(fork) marks the window (`recordFork`), with when the parent last answered
 *   (`seconds_since_last_response`);
 * - the first `stop-sleep` or SessionEnd that finds the fork's turn map (`hwm.json`, which its delta encoder has
 *   just written) looks for the parent among the windows of the transcripts beside its own: the most recently encoded
 *   first, or those nearest the parent's last answer, at most 32. The parent is the one whose turn map holds the
 *   newest of the fork's lines; a window that is itself a fork loses a tie, so a sibling fork of the same point is not
 *   taken for the parent;
 * - the fork point is that line's turn. The parent's prompts after it were never in the fork's context, so their
 *   deliveries are not copied (`inheritLedger`).
 * The fork's first turn therefore runs on its own, empty ledger. A fork subagent's copy waits for a delivery point in
 * the child window (P2.5).
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { turnMap, type TurnMap } from "./memory-delta";
import { inheritLedger } from "./memory-ledger";
import { forkMark, recordFork, windowDir } from "./memory-window";

/** The windows a fork looks through for its parent. */
const MAX_CANDIDATES = 32;
const TRANSCRIPT = ".jsonl";

/** A candidate parent: its window, when its turn map was written, and the map. */
interface Candidate {
  dir: string;
  mtime: number;
  map: TurnMap;
}

/** The windows of the sessions whose transcripts sit beside `transcriptPath`, other than `win`, with a turn map. */
function candidates(root: string, win: string, transcriptPath: string, last?: number): Candidate[] {
  let names: string[];
  try {
    names = readdirSync(dirname(transcriptPath));
  } catch {
    return [];
  }
  const found = names.flatMap((name) => {
    const dir = name.endsWith(TRANSCRIPT) ? windowDir(root, name.slice(0, -TRANSCRIPT.length)) : undefined;
    const mtime = dir && dir !== win ? statSync(join(dir, "hwm.json"), { throwIfNoEntry: false })?.mtimeMs : undefined;
    return dir && mtime !== undefined ? [{ dir, mtime }] : [];
  });
  const distance = (mtime: number) => (last === undefined ? -mtime : Math.abs(mtime - last));
  return found
    .sort((a, b) => distance(a.mtime) - distance(b.mtime))
    .slice(0, MAX_CANDIDATES)
    .flatMap(({ dir, mtime }) => {
      const map = turnMap(dir);
      return map ? [{ dir, mtime, map }] : [];
    });
}

/** The parent, and the newest of the fork's lines its turn map holds (see the header). */
function findParent(fork: TurnMap, found: readonly Candidate[]): { parent: Candidate; line: string } | undefined {
  const lines = [...fork.lines.keys()];
  let best: { parent: Candidate; line: string; at: number; forked: boolean } | undefined;
  for (const parent of found) {
    const at = lines.findLastIndex((uuid) => parent.map.lines.has(uuid));
    if (at < 0) continue;
    const forked = forkMark(parent.dir) !== undefined;
    if (!best || at > best.at || (at === best.at && best.forked && !forked))
      best = { parent, line: lines[at]!, at, forked };
  }
  return best && { parent: best.parent, line: best.line };
}

/**
 * The parent's prompts after the fork point (`line`'s turn): their `promptId`s. None when the turn is unresolved:
 * copying a delivery the fork never got costs one missed bullet, not copying one costs a repeat on every cue.
 */
function promptsAfter(parent: TurnMap, line: string): Set<string> {
  const turn = parent.lines.get(line);
  if (turn === "" || turn === undefined) return new Set();
  const at = turn === null ? -1 : parent.prompts.findIndex((prompt) => prompt.u === turn);
  if (turn !== null && at < 0) return new Set();
  return new Set(parent.prompts.slice(at + 1).flatMap((prompt) => (prompt.id ? [prompt.id] : [])));
}

/** SessionStart(fork): marks the window, with when the parent last answered when the payload says. */
export function markFork(win: string, now: number, secondsSinceLastResponse: unknown): void {
  const seconds = typeof secondsSinceLastResponse === "number" ? secondsSinceLastResponse : undefined;
  recordFork(win, seconds === undefined ? {} : { last: now - seconds * 1000 });
}

/**
 * Copies a marked fork's parent ledger once its turn map exists (see the header), and resolves the mark. Returns the
 * parent's window name ("" when none was found) and how many deliveries were copied; nothing for a window that is
 * not a pending fork, or whose turn map is not written yet.
 */
export function inheritFork(
  root: string,
  win: string,
  transcriptPath: string,
): { from: string; copied: number } | undefined {
  const mark = forkMark(win);
  if (!mark || mark.from !== undefined || !transcriptPath) return undefined;
  const fork = turnMap(win);
  if (!fork?.lines.size) return undefined;
  const found = findParent(fork, candidates(root, win, transcriptPath, mark.last));
  const copied = found ? inheritLedger(found.parent.dir, win, promptsAfter(found.parent.map, found.line)) : 0;
  const from = found ? basename(found.parent.dir) : "";
  recordFork(win, { from });
  return { from, copied };
}
