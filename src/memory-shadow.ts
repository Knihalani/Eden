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
 * - **From disk** (no InstructionsLoaded fires for them): AGENTS.md (or `.claude/AGENTS.md`), which Claude Code loads
 *   by default only where the project has no CLAUDE.md of its own, from the session's folder up to the repo's top
 *   (captured: with a CLAUDE.md it was not in context, without one it was); and the auto-memory `MEMORY.md` of the
 *   session's project (`memoryIndex`), of which Claude Code loads the first 200 lines, at most 25,000 bytes.
 *
 * A subagent's window gets no InstructionsLoaded (R0 F35) and no delivery point yet: its shadow set (its type's files,
 * D27) waits for SubagentStart delivery (P2.5). The records hold paths, never file text; the files are read at each
 * delivery, so an edit counts at once.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { abandonedPrompts } from "./memory-delta";
import { gitPlace, mainCheckout, realpathOrSelf, type GitPlace } from "./memory-repo";
import { residualSentences, type Said } from "./memory-residual";
import { appendRecord, windowRecords } from "./memory-window";

const SHADOW = "shadow.log";
/** Loads that last for the window's whole session; the others are lazy (see the header). */
const EAGER = new Set(["session_start", "include", "compact"]);
/**
 * The most text a delivery reads, over all the files in order, and the most files it opens: a bound on its cost
 * (A7 §8; a 64 KB set parses in about 5 ms). Past it, the rest of the set is not read, which costs a repeat, not a
 * miss.
 */
const TOTAL_BYTES = 64 * 1024;
const MAX_FILES = 64;
/** Claude Code's auto-memory index limits (2.1.294). */
const MEMORY_LINES = 200;
const MEMORY_BYTES = 25_000;
/** Claude Code's project folder names: the path with every other character "-", hashed past 200 (2.1.294). */
const PROJECT_NAME_LENGTH = 200;
/** Files that make a folder's CLAUDE.md "its own", so AGENTS.md is not loaded there by default. */
const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
/** The AGENTS.md names Claude Code reads (2.1.294). */
const AGENTS_FILES = ["AGENTS.md", join(".claude", "AGENTS.md")];

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
  return folders.flatMap((folder) => AGENTS_FILES.map((name) => join(folder, name))).filter((path) => existsSync(path));
}

/**
 * The auto-memory index Claude Code loads into the session (2.1.294's `defaultPath`): `MEMORY.md` in the `memory`
 * folder of the project's folder under `projects/`, beside the session's own folder (the transcript's). The project is
 * the canonical root of the session's repo: a worktree's main checkout, the repo's top for a subfolder, else the
 * session's folder. None when auto memory is turned off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`); the `autoMemoryEnabled`
 * and `autoMemoryDirectory` settings are not read.
 */
function memoryIndex(cwd: string, git: GitPlace | undefined, transcriptPath: string): string | undefined {
  const off = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  if (off && !/^(?:0|false)$/i.test(off)) return undefined;
  const projects = dirname(dirname(transcriptPath));
  const name = realpathOrSelf(git ? mainCheckout(git) : cwd).replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= PROJECT_NAME_LENGTH) return join(projects, name, "memory", "MEMORY.md");
  const prefix = `${name.slice(0, PROJECT_NAME_LENGTH)}-`;
  try {
    const folder = readdirSync(projects).find((entry) => entry.startsWith(prefix));
    return folder ? join(projects, folder, "memory", "MEMORY.md") : undefined;
  } catch {
    return undefined;
  }
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

/** Where the window's session runs: its folder and its transcript (auto memory sits beside the transcript's folder). */
export interface ShadowPlace {
  cwd?: string;
  transcriptPath?: string;
}

/**
 * The text of every file in the window's shadow set (see the header), in order: the loaded files, AGENTS.md, then
 * MEMORY.md, within `TOTAL_BYTES` in all.
 */
export function shadowTexts(dir: string | undefined, place: ShadowPlace): string[] {
  const git = place.cwd ? gitPlace(place.cwd) : undefined;
  const files = [...(dir ? loadedInstructions(dir) : []), ...(place.cwd ? agentsFiles(place.cwd, git?.top) : [])];
  const index = place.cwd && place.transcriptPath ? memoryIndex(place.cwd, git, place.transcriptPath) : undefined;
  const texts: string[] = [];
  let left = TOTAL_BYTES;
  for (const path of [...new Set(files)].slice(0, MAX_FILES)) {
    if (left <= 0) break;
    const text = head(path, left);
    left -= Buffer.byteLength(text);
    texts.push(text);
  }
  if (index && left > 0)
    texts.push(head(index, Math.min(left, MEMORY_BYTES)).split("\n").slice(0, MEMORY_LINES).join("\n"));
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
