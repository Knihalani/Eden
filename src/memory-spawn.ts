/**
 * A subagent's scope (A4 §5.3, D23): SubagentStart's payload names only the agent's id and type (R0 F27), so the task
 * it was launched with is read where it is still visible, at `PreToolUse(Agent)`.
 *
 * - **The launch record.** `PreToolUse(Agent)` appends `{k: "spawn", id, type, paths, classes, t}` to the session's
 *   `windows/<session>/spawn.log`: the call's `tool_use_id`, its `subagent_type` (Claude Code's default,
 *   `general-purpose`, when the call names none), the places of the repo its task names, and the action classes its
 *   task names (A7 §5, the compiled triggers' reading). Never the task's text (X11). A nested subagent's launch goes to
 *   the session's window too: SubagentStart's payload does not say which window launched it.
 * - **The claim.** SubagentStart takes A4's record: the newest unconsumed one of its type made within 5 s, and marks it
 *   consumed (a `take` record) under `flock(spawn.lock)`. Claude Code 2.1.294 (P2.5's end-to-end) runs each Agent
 *   call's PreToolUse and then its SubagentStart, one call after the other in a parallel batch too, so the newest of
 *   the type is the subagent's own launch. The subagent's meta file, which names the call's `tool_use_id`, is written
 *   only after SubagentStart returns, so it cannot match them.
 * - **The child's scope** is its task's paths and classes, or, with no record to take, the parent's recent paths (the
 *   paths of its last 3 human turns' tool batches: D4's main-thread paths, until P3.2 builds the read set). It is
 *   stored in the child's `scope.json`, which a resumed subagent reuses.
 * - **An agent type's classes:** those its name fires, its agentive ending read as the verb ("code-reviewer" is
 *   review), plus the classes `memory-classes.json`'s `agents` map adds (A4 §5.3: a reviewer gets the merge policies).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { AGENT_CLASSES, type ActionClass } from "./memory-classes";
import { realpathOrSelf } from "./memory-repo";
import { firedClasses } from "./memory-triggers";
import { appendRecord, windowRecords } from "./memory-window";

/** One launch, as `PreToolUse(Agent)` records it (see the header). */
export interface Spawn {
  id: string;
  type: string;
  paths: string[];
  classes: ActionClass[];
  t: number;
}

/** A child window's scope (see the header). */
export interface ChildScope {
  paths: string[];
  classes: ActionClass[];
  from: "task" | "parent";
}

const SPAWN_LOG = "spawn.log";
const SPAWN_LOCK = "spawn.lock";
const SCOPE = "scope.json";
/** A4 §5.3: a launch record a SubagentStart of its type may take by time alone. */
const CLAIM_MS = 5_000;
/** A record line stays under 4 KB (`memory-window.ts`): at most 8 paths of at most 200 characters. */
const MAX_PATHS = 8;
const MAX_PATH = 200;
/** D4's window for main-thread paths: the last 3 human turns. */
const RECENT_TURNS = 3;
/** Claude Code's type for an Agent call that names none (in fork mode too). */
const DEFAULT_TYPE = "general-purpose";

const URL = /\b[a-z][\w+.-]*:\/\/\S*/gi;
const PATH_SHAPED = /^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\/?$/;
const FILE_NAME = /^[\w.-]+\.[A-Za-z]\w{0,7}$/;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asRec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A path relative to the repo's top, if it is inside it; "" for the top itself. */
function underTop(path: string, top: string): string | undefined {
  if (!isAbsolute(path)) return normalize(path).replace(/^\.\/+/, "");
  for (const base of new Set([top, realpathOrSelf(top)])) {
    const rel = relative(base, path);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return undefined;
}

/** A place of the repo: it exists under the top, or, for a path with a folder, its folder does (a file to create). */
function inRepo(rel: string, top: string): boolean {
  if (!rel || rel.startsWith("..")) return false;
  const path = join(top, rel);
  return existsSync(path) || (rel.includes("/") && existsSync(dirname(path)));
}

/**
 * The places of the repo a text names, in order, each once, at most 8 (see the header): paths with a folder, and file
 * names, that exist under `top` (or whose folder does). URLs are not places; absolute paths outside `top` are not the
 * repo's.
 */
export function taskPaths(task: string, top: string): string[] {
  const out: string[] = [];
  for (const raw of String(task ?? "")
    .replace(URL, " ")
    .split(/[\s,;()[\]{}<>"'`]+/)) {
    const token = raw.replace(/[.:!?]+$/, "");
    if (!token || token.length > MAX_PATH || !(token.includes("/") ? PATH_SHAPED : FILE_NAME).test(token)) continue;
    const rel = underTop(token, top)?.replace(/\/+$/, "");
    if (rel && inRepo(rel, top) && !out.includes(rel)) out.push(rel);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/** A `PreToolUse(Agent)` payload's launch record (see the header); none for another tool or a call with no id. */
export function spawnOf(payload: Record<string, unknown>, top: string, now: number): Spawn | undefined {
  const id = str(payload.tool_use_id);
  if (payload.tool_name !== "Agent" || !id) return undefined;
  const input = asRec(payload.tool_input);
  const task = [str(input.description), str(input.prompt)].filter(Boolean).join("\n");
  return {
    id,
    type: str(input.subagent_type) ?? DEFAULT_TYPE,
    paths: taskPaths(task, top),
    classes: firedClasses(task),
    t: now,
  };
}

/** Appends a launch record to the session's window (see the header). */
export function recordSpawn(win: string, spawn: Spawn): void {
  appendRecord(win, SPAWN_LOG, { k: "spawn", ...spawn });
}

function spawnRecord(record: Record<string, unknown>): Spawn | undefined {
  const { id, type, paths, classes, t } = record;
  if (record.k !== "spawn" || typeof id !== "string" || typeof type !== "string" || typeof t !== "number")
    return undefined;
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  return { id, type, paths: strings(paths), classes: strings(classes) as ActionClass[], t };
}

/** What a SubagentStart claims: its type and its agent's id. */
export interface Claim {
  type: string;
  now: number;
  agent: string;
  /** False in read-only consent: the record is found, not consumed. */
  mark?: boolean;
}

/** The record a claim takes, if one is unconsumed (see the header). */
function pick(win: string, want: Claim): Spawn | undefined {
  const records = windowRecords(win, SPAWN_LOG);
  const taken = new Set(records.flatMap((record) => (record.k === "take" ? [record.id] : [])));
  const open = records.flatMap((record) => spawnRecord(record) ?? []).filter((spawn) => !taken.has(spawn.id));
  return open.findLast((spawn) => spawn.type === want.type && Math.abs(want.now - spawn.t) <= CLAIM_MS);
}

/** A SubagentStart's claim of its launch record (see the header); marks it consumed unless `mark` is false. */
export function claimSpawn(win: string, want: Claim): Spawn | undefined {
  if (want.mark === false) return pick(win, want);
  if (!existsSync(join(win, SPAWN_LOG))) return undefined;
  return withFileLock(join(win, SPAWN_LOCK), () => {
    const spawn = pick(win, want);
    if (spawn) appendRecord(win, SPAWN_LOG, { k: "take", id: spawn.id, agent: want.agent, t: want.now });
    return spawn;
  });
}

/** The scope a child window stored at its first SubagentStart; none before. */
export function storedScope(win: string): ChildScope | undefined {
  try {
    const value = asRec(JSON.parse(readFileSync(join(win, SCOPE), "utf8")));
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((s) => typeof s === "string") : []);
    const from = value.from === "parent" ? "parent" : "task";
    return { paths: strings(value.paths), classes: strings(value.classes) as ActionClass[], from };
  } catch {
    return undefined;
  }
}

export function storeScope(win: string, scope: ChildScope): void {
  mkdirSync(win, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(win, SCOPE), JSON.stringify(scope), 0o600);
}

/**
 * The parent's recent paths: those its tool batches named in its last 3 human turns, newest first, as places of the
 * repo (see the header).
 */
export function parentPaths(win: string, top: string): string[] {
  const batches = windowRecords(win, "ctx.log").filter((record) => record.k === "batch");
  const turns = [...new Set(batches.map((batch) => batch.prompt_id))].slice(-RECENT_TURNS);
  const out: string[] = [];
  for (const batch of batches.filter((record) => turns.includes(record.prompt_id)).reverse()) {
    for (const path of Array.isArray(batch.paths) ? batch.paths : []) {
      const rel = typeof path === "string" ? underTop(path, top) : undefined;
      if (rel && !rel.startsWith("..") && !out.includes(rel)) out.push(rel);
    }
  }
  return out.slice(0, MAX_PATHS);
}

/** The classes an agent type's name fits (see the header). */
export function agentClasses(type: string): ActionClass[] {
  const words = String(type ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const forms = words.flatMap((word) => [word, word.replace(/(?:er|or)$/, ""), word.replace(/r$/, "")]);
  const fired = forms.length ? firedClasses([...new Set(forms)].join(" ")) : [];
  return [...new Set([...fired, ...fired.flatMap((cls) => AGENT_CLASSES[cls] ?? [])])];
}
