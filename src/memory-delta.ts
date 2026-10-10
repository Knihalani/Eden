/**
 * The delta encoder (A4 §3.3): a window encodes its transcript once, line by line, from a high-water mark, instead
 * of reading the whole file at every event.
 *
 * - **`hwm.json`** (the window's directory) holds the byte offset after the last complete line read, the window's
 *   typed prompts, a rolling map of the last 5,000 lines to their turn, and the `promptId`s a rewind abandoned. It is
 *   advanced only under `hwm.lock`, taken without waiting: a hook that finds it held leaves the delta to the holder.
 *   A hook that finds nothing new leaves the mark as it is.
 *   A window with no mark starts at its transcript's last 256 KB, the most the hook read before P0.6.
 * - **Turns.** A line's turn is its nearest typed-prompt ancestor by `parentUuid` (`logicalParentUuid` across a
 *   compaction's boundary, whose `parentUuid` is null). A typed prompt is a user line that carries the user's
 *   authority (`userTyped`, D12). Each text read from a line carries the line's uuid, its time and its turn's
 *   `promptId`, so rows can name the line they came from and be taken back with their turn.
 * - **Typed prompts are not encoded here.** The Submit payload carries the prompt before its line is written
 *   (R0 F8), split into the user's words and their pastes against the tool results of that moment (D12).
 * - **Rewind.** A typed prompt whose parent turn is not the previously newest typed prompt is a branch point: every
 *   typed prompt from the previous newest back to that turn is abandoned. When that walk cannot reach the turn (a
 *   parent outside the map), nothing is abandoned: one missed re-injection is cheaper than a repeat on every turn.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { authoredTexts, userTyped, type TextSource } from "./memory-authority";

/** The transcript lines the turn map keeps (A4 §3.3). */
export const TURN_MAP_LINES = 5_000;
/** Where a window with no mark starts: its transcript's last 256 KB. */
const FIRST_READ_BYTES = 256 * 1024;
/** The most one invocation reads; the next one reads on from where it stopped. */
const MAX_DELTA_BYTES = 4 * 1024 * 1024;
/** Typed prompts and abandoned ids the mark keeps: a rewind reaches back a few prompts, never hundreds. */
const KEPT_PROMPTS = 500;
/** The tool results before a line that the paste rule reads (A6 §2.1). */
const RECENT_TOOL_RESULTS = 10;

const HWM = "hwm.json";
const LOCK = "hwm.lock";

/** A typed prompt: its line, its parent turn (null at the root, "" when unresolved), and its `promptId`. */
interface TypedPrompt {
  u: string;
  p: string | null;
  id?: string;
}

interface Mark {
  v: 1;
  path: string;
  off: number;
  /** The newest typed prompt's line. */
  last?: string;
  prompts: TypedPrompt[];
  /** Line uuid → its turn: a typed prompt's uuid, null before the first one, "" when unresolved. */
  lines: [string, string | null][];
  abandoned: string[];
}

/** A text the delta holds, by source (D12), with the line it came from. */
export interface DeltaMessage {
  role: "user" | "assistant";
  content: string;
  src?: TextSource;
  /** The line's `timestamp`, in epoch ms. */
  at?: number;
  uuid?: string;
  /** The `promptId` of the line's turn. */
  promptId?: string;
}

export interface Delta {
  messages: DeltaMessage[];
  /** The `promptId`s this delta's branch points abandoned. */
  abandoned: string[];
  /** The texts the delta's lines on the current branch state, which a rewind must not take back. */
  branchTexts: string[];
}

const UNRESOLVED = "";

function emptyMark(path: string, off: number): Mark {
  return { v: 1, path, off, prompts: [], lines: [], abandoned: [] };
}

function readMark(win: string): Mark | undefined {
  try {
    const mark = JSON.parse(readFileSync(join(win, HWM), "utf8")) as Mark;
    return mark?.v === 1 && typeof mark.off === "number" && Array.isArray(mark.lines) ? mark : undefined;
  } catch {
    return undefined;
  }
}

/** The `promptId`s a rewind abandoned in this window (the ledger's branch check, A4 §4). */
export function abandonedPrompts(win: string): Set<string> {
  return new Set(readMark(win)?.abandoned ?? []);
}

/** The bytes from `off` to the last newline (at most `MAX_DELTA_BYTES`, or one whole line), and where they end. */
function completeLines(path: string, off: number): { text: string; end: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= off) return { text: "", end: Math.min(off, size) };
    let length = Math.min(size - off, MAX_DELTA_BYTES);
    let buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, off);
    let last = buffer.lastIndexOf(10);
    if (last < 0 && length < size - off) {
      length = size - off;
      buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, off);
      last = buffer.lastIndexOf(10);
    }
    if (last < 0) return { text: "", end: off };
    return { text: buffer.subarray(0, last + 1).toString("utf8"), end: off + last + 1 };
  } finally {
    closeSync(fd);
  }
}

/** Where a window with no mark starts reading: after the first newline of the last `FIRST_READ_BYTES`. */
function firstOffset(path: string): number {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= FIRST_READ_BYTES) return 0;
    const start = size - FIRST_READ_BYTES;
    const buffer = Buffer.alloc(FIRST_READ_BYTES);
    readSync(fd, buffer, 0, buffer.length, start);
    const newline = buffer.indexOf(10);
    return newline < 0 ? size : start + newline + 1;
  } finally {
    closeSync(fd);
  }
}

function timeOf(line: Record<string, unknown>): number | undefined {
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** The typed prompts a rewind to `parent` abandons: from the newest back to `parent`, or none if it is not reached. */
function abandonedBy(mark: Mark, parent: string | null): TypedPrompt[] {
  const byUuid = new Map(mark.prompts.map((prompt) => [prompt.u, prompt]));
  const walked: TypedPrompt[] = [];
  let at: string | null | undefined = mark.last;
  while (at !== parent) {
    const prompt: TypedPrompt | undefined = typeof at === "string" ? byUuid.get(at) : undefined;
    if (!prompt || prompt.p === UNRESOLVED || walked.length >= mark.prompts.length) return [];
    walked.push(prompt);
    at = prompt.p;
  }
  return walked;
}

/** Reads the lines of `text` into `mark`'s turn map and returns what they say (see the header). */
function readLines(mark: Mark, text: string): Delta {
  const turns = new Map(mark.lines);
  const abandoned: string[] = [];
  const said: (DeltaMessage & { typed: boolean })[] = [];
  const tools: string[] = [];
  const promptIds = new Map(mark.prompts.map((prompt) => [prompt.u, prompt.id]));
  for (const raw of text.split("\n")) {
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      line = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const uuid = typeof line.uuid === "string" ? line.uuid : undefined;
    const parentUuid =
      typeof line.parentUuid === "string"
        ? line.parentUuid
        : typeof line.logicalParentUuid === "string"
          ? line.logicalParentUuid
          : null;
    const parentTurn = parentUuid === null ? null : (turns.get(parentUuid) ?? UNRESOLVED);
    const typed = line.type === "user" && uuid !== undefined && userTyped(line) !== undefined;
    if (typed) {
      if (mark.last !== undefined && parentTurn !== UNRESOLVED && parentTurn !== mark.last) {
        for (const prompt of abandonedBy(mark, parentTurn)) if (prompt.id) abandoned.push(prompt.id);
      }
      const promptId = typeof line.promptId === "string" ? line.promptId : undefined;
      mark.prompts.push({ u: uuid, p: parentTurn, ...(promptId ? { id: promptId } : {}) });
      promptIds.set(uuid, promptId);
      mark.last = uuid;
      turns.delete(uuid);
      turns.set(uuid, uuid);
    } else if (uuid !== undefined) {
      turns.delete(uuid);
      turns.set(uuid, parentTurn);
    }
    const turn = uuid === undefined ? undefined : turns.get(uuid);
    const promptId = turn ? promptIds.get(turn) : undefined;
    const at = timeOf(line);
    for (const { src, text: content } of authoredTexts(line, tools.slice(-RECENT_TOOL_RESULTS))) {
      if (src === "tool") tools.push(content);
      said.push({
        role: src === "agent" ? "assistant" : "user",
        content,
        src,
        typed: src === "user" || src === "paste",
        ...(at === undefined ? {} : { at }),
        ...(uuid === undefined ? {} : { uuid }),
        ...(promptId ? { promptId } : {}),
      });
    }
  }
  mark.lines = [...turns].slice(-TURN_MAP_LINES);
  mark.prompts = mark.prompts.slice(-KEPT_PROMPTS);
  mark.abandoned = [...new Set([...mark.abandoned, ...abandoned])].slice(-KEPT_PROMPTS);
  const gone = new Set(mark.abandoned);
  const onBranch = said.filter((message) => !message.promptId || !gone.has(message.promptId));
  return {
    messages: onBranch.filter((message) => !message.typed).map(({ typed: _, ...message }) => message),
    abandoned,
    branchTexts: onBranch.map((message) => message.content),
  };
}

/**
 * Reads the window's new complete transcript lines and hands them to `encode`, then advances the mark, all under
 * `hwm.lock`. Undefined when another hook holds the lock or there is no transcript: that hook, or a later one,
 * reads the lines. A delta whose `encode` throws is still marked read, so one bad line cannot stall the window.
 */
export function encodeDelta(win: string, transcriptPath: string, encode: (delta: Delta) => void): Delta | undefined {
  if (!transcriptPath) return undefined;
  mkdirSync(win, { recursive: true, mode: 0o700 });
  try {
    return withFileLock(
      join(win, LOCK),
      () => {
        const held = readMark(win);
        const mark = held?.path === transcriptPath ? held : emptyMark(transcriptPath, firstOffset(transcriptPath));
        const { text, end } = completeLines(transcriptPath, mark.off);
        if (mark === held && end === held.off) return { messages: [], abandoned: [], branchTexts: [] };
        mark.off = end;
        const delta = readLines(mark, text);
        try {
          if (delta.messages.length || delta.abandoned.length) encode(delta);
        } finally {
          writeFileAtomic(join(win, HWM), JSON.stringify(mark), 0o600);
        }
        return delta;
      },
      0,
    );
  } catch {
    return undefined;
  }
}
