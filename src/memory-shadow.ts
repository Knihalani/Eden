/**
 * D27's shadow set: the instruction files in a window's context. What they already state is never delivered
 * (`memory-delivery.ts`, read with D26's test, `unsaidText`). Kept per window (R7 §13) in `windows/<win>/shadow.log`.
 *
 * - **InstructionsLoaded** appends a `load` record: the file, why Claude Code loaded it, and the `prompt_id` of a lazy
 *   load. It runs async and opens no store; a record the window already holds since its last epoch is not appended
 *   again (an eager CLAUDE.md is reported at every process start, twice on a resume).
 * - **Epochs.** SessionStart `compact` and `clear` append an `epoch` record. Captured on Claude Code 2.1.294:
 *   lazily loaded files (`nested_traversal`, `path_glob_match`) leave the context at a compaction, which reloads
 *   nothing, while eagerly loaded ones (`session_start`, `include`, `compact`) stay. So a lazy load counts only after
 *   the last epoch, and only while its prompt is on the current branch (a rewind abandons it, `memory-delta.ts`).
 * - **From disk** (no InstructionsLoaded fires for them): AGENTS.md, which Claude Code loads by default only where the
 *   project has no CLAUDE.md of its own, from the session's folder up to the repo's top (captured: with a CLAUDE.md it
 *   was not in context, without one it was); and auto-memory `MEMORY.md` beside the session's transcript, of which
 *   Claude Code loads the first 200 lines, at most 25,000 bytes.
 *
 * A subagent's window gets no InstructionsLoaded (R0 F35) and no delivery point yet: its shadow set (its type's files,
 * D27) waits for SubagentStart delivery (P2.5). The records hold paths, never file text; the files are read at each
 * delivery, so an edit counts at once.
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { abandonedPrompts } from "./memory-delta";
import { residualSentences, type Said } from "./memory-residual";
import { appendRecord, windowRecords } from "./memory-window";

const SHADOW = "shadow.log";
/** Loads that last for the window's whole session; the others are lazy (see the header). */
const EAGER = new Set(["session_start", "include", "compact"]);
/** The most of one instruction file read, and the most files: a bound on a delivery's cost. */
const FILE_BYTES = 256 * 1024;
const MAX_FILES = 64;
/** Claude Code's auto-memory index limits (2.1.294). */
const MEMORY_LINES = 200;
const MEMORY_BYTES = 25_000;
/** Files that make a folder's CLAUDE.md "its own", so AGENTS.md is not loaded there by default. */
const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];

interface Load {
  path: string;
  reason: string;
  att?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The loads of the window's current epoch, eager ones from every epoch, before rewinds are applied. */
function currentLoads(dir: string): Load[] {
  const loads: Load[] = [];
  for (const record of windowRecords(dir, SHADOW)) {
    if (record.k === "epoch") {
      loads.splice(0, loads.length, ...loads.filter((load) => EAGER.has(load.reason)));
      continue;
    }
    const path = str(record.path);
    const reason = str(record.reason);
    const att = str(record.att);
    if (record.k === "load" && path && reason) loads.push({ path, reason, ...(att ? { att } : {}) });
  }
  return loads;
}

/** InstructionsLoaded: records the file in the window, unless its current epoch already holds this load. */
export function recordInstructions(dir: string, payload: Record<string, unknown>): void {
  const path = str(payload.file_path);
  const reason = str(payload.load_reason);
  if (!path || !reason) return;
  const att = EAGER.has(reason) ? undefined : str(payload.prompt_id);
  const held = currentLoads(dir).some(
    (load) => load.path === path && (EAGER.has(reason) ? EAGER.has(load.reason) : load.att === att),
  );
  if (!held) appendRecord(dir, SHADOW, { k: "load", path, reason, ...(att ? { att } : {}) });
}

/** SessionStart `compact` or `clear`: the window's lazily loaded files leave its context. */
export function startShadowEpoch(dir: string): void {
  appendRecord(dir, SHADOW, { k: "epoch" });
}

/** The instruction files InstructionsLoaded reported that are in the window's context now (see the header). */
export function loadedInstructions(dir: string): string[] {
  let abandoned: Set<string> | undefined;
  const paths = currentLoads(dir).flatMap((load) => {
    if (load.att === undefined) return [load.path];
    abandoned ??= abandonedPrompts(dir);
    return abandoned.has(load.att) ? [] : [load.path];
  });
  return [...new Set(paths)];
}

/** The folders from `cwd` up to the repo's `top` (only `cwd` outside git, or when `cwd` is not under `top`). */
function foldersUp(cwd: string, top: string | undefined): string[] {
  const folders = [cwd];
  if (!top || relative(top, cwd).startsWith("..")) return folders;
  for (let at = cwd; at !== top && dirname(at) !== at;) folders.push((at = dirname(at)));
  return folders;
}

/** AGENTS.md files Claude Code loads by default: those of a project with no CLAUDE.md of its own (see the header). */
function agentsFiles(cwd: string, top: string | undefined): string[] {
  const folders = foldersUp(cwd, top);
  if (folders.some((folder) => CLAUDE_FILES.some((name) => existsSync(join(folder, name))))) return [];
  return folders.map((folder) => join(folder, "AGENTS.md")).filter((path) => existsSync(path));
}

/** A file's first `bytes`, or "" when it cannot be read. */
function head(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, bytes, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

/** Where the window's session runs: its folder, its repo's top, and its transcript (auto memory sits beside it). */
export interface ShadowPlace {
  cwd?: string;
  top?: string;
  transcriptPath?: string;
}

/** The text of every file in the window's shadow set (see the header). */
export function shadowTexts(dir: string | undefined, place: ShadowPlace): string[] {
  const files = [
    ...(dir ? loadedInstructions(dir) : []),
    ...(place.cwd ? agentsFiles(place.cwd, place.top) : []),
  ].slice(0, MAX_FILES);
  const texts = [...new Set(files)].map((path) => head(path, FILE_BYTES));
  if (place.transcriptPath) {
    const index = head(join(dirname(place.transcriptPath), "memory", "MEMORY.md"), MEMORY_BYTES);
    texts.push(index.split("\n").slice(0, MEMORY_LINES).join("\n"));
  }
  return texts.filter(Boolean);
}

/** The shadow set's sentences, for D26's test (`unsaidText`); none when they cannot be read (fail open). */
export function shadowSentences(dir: string | undefined, place: ShadowPlace): Said[] {
  try {
    return residualSentences(shadowTexts(dir, place));
  } catch {
    return [];
  }
}
