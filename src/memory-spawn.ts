/**
 * A subagent's scope (A4 §5.3, D23): SubagentStart's payload names only the agent's id and type (R0 F27), so the task
 * it was launched with is read where it is still visible, at `PreToolUse(Agent)`.
 *
 * - **The launch record.** `PreToolUse(Agent)` appends `{k: "spawn", id, type, paths, classes, t}` to the session's
 *   `windows/<session>/spawn.log`: the call's `tool_use_id`, its `subagent_type` (Claude Code's default,
 *   `general-purpose`, when the call names none), the places of the repo its task names (a relative path read from
 *   the session's folder first, then from the repo's top), and the action classes its task names (A7 §5, the
 *   compiled triggers' reading). Never the task's text (X11). A nested subagent's launch goes to
 *   the session's window too: SubagentStart's payload does not say which window launched it.
 * - **The claim.** SubagentStart takes A4's record, the unconsumed one of its type made within 5 s, and marks it
 *   consumed (a `take` record) under `flock(spawn.lock)`. Claude Code 2.1.294 (P2.5's end-to-end) runs each Agent
 *   call's PreToolUse and then its SubagentStart, one call after the other in a parallel batch too, so there is one:
 *   the subagent's own launch. When two are open, which is whose cannot be told (the subagent's meta file, which
 *   names the call's `tool_use_id`, is written only after SubagentStart returns), so none is taken and the subagent
 *   gets the parent's paths: A5 `subagent` allows parallel launches their own scopes or both the parent's, never each
 *   other's.
 * - **The child's scope** is its task's paths and classes, and the read set they make (D4); or, with no record to take
 *   or a task naming no place, the parent's read set, with its recent paths as the cue (`parentPaths`). It is stored in
 *   the child's `scope.json`, which a resumed subagent reuses.
 * - **An agent type's classes:** those its name fires, its agentive ending read as the verb ("code-reviewer" is
 *   review), plus the classes `memory-classes.json`'s `agents` map adds (A4 §5.3: a reviewer gets the merge policies).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { AGENT_CLASSES, type ActionClass } from "./memory-classes";
import { taskPaths, underTop, windowPaths } from "./memory-place";
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
  /** Its read set (D4, `memory-place.ts`): its task's, or the parent's; absent in a scope stored before P3.2. */
  scopes?: string[];
}

const SPAWN_LOG = "spawn.log";
const SPAWN_LOCK = "spawn.lock";
const SCOPE = "scope.json";
/** A4 §5.3: a launch record a SubagentStart of its type may take by time alone. */
const CLAIM_MS = 5_000;
/** A record line stays under 4 KB (`memory-window.ts`): at most 8 paths. */
const MAX_PATHS = 8;
/** Claude Code's type for an Agent call that names none (in fork mode too). */
const DEFAULT_TYPE = "general-purpose";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asRec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A `PreToolUse(Agent)` payload's launch record (see the header); none for another tool or a call with no id. */
export function spawnOf(payload: Record<string, unknown>, top: string, now: number, cwd = top): Spawn | undefined {
  const id = str(payload.tool_use_id);
  if (payload.tool_name !== "Agent" || !id) return undefined;
  const input = asRec(payload.tool_input);
  const task = [str(input.description), str(input.prompt)].filter(Boolean).join("\n");
  return {
    id,
    type: str(input.subagent_type) ?? DEFAULT_TYPE,
    paths: taskPaths(task, top, cwd),
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
  const mine = open.filter((spawn) => spawn.type === want.type && Math.abs(want.now - spawn.t) <= CLAIM_MS);
  return mine.length === 1 ? mine[0] : undefined;
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
    const scope: ChildScope = { paths: strings(value.paths), classes: strings(value.classes) as ActionClass[], from };
    return Array.isArray(value.scopes) ? { ...scope, scopes: strings(value.scopes) } : scope;
  } catch {
    return undefined;
  }
}

export function storeScope(win: string, scope: ChildScope): void {
  mkdirSync(win, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(win, SCOPE), JSON.stringify(scope), 0o600);
}

/**
 * The parent's recent paths: those its current prompt named and its last 3 human turns' tool batches and Bash
 * commands touched (D4's main-thread paths, `memory-place.ts`), newest first, as places of the repo (see the header).
 */
export function parentPaths(win: string, top: string): string[] {
  const { prompt, turns, bash } = windowPaths(win);
  const out: string[] = [];
  for (const path of [...prompt, ...turns, ...bash]) {
    const rel = underTop(path, top);
    if (rel && !rel.startsWith("..") && !out.includes(rel)) out.push(rel);
  }
  return out.slice(0, MAX_PATHS);
}

/**
 * A word and the verbs its agentive ending may stand for: "reviewer" review, "committer" commit, "migrator" migrate.
 */
function agentForms(word: string): string[] {
  const stem = word.replace(/(?:er|or)$/, "");
  return [word, stem, word.replace(/r$/, ""), stem.replace(/(.)\1$/, "$1"), word.replace(/ator$/, "ate")];
}

/** The classes an agent type's name fits (see the header). */
export function agentClasses(type: string): ActionClass[] {
  const words = String(type ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const forms = words.flatMap(agentForms);
  const fired = forms.length ? firedClasses([...new Set(forms)].join(" ")) : [];
  return [...new Set([...fired, ...fired.flatMap((cls) => AGENT_CLASSES[cls] ?? [])])];
}
