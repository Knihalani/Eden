/**
 * A4 §5.3, D23: how a SubagentStart finds its task's scope though its payload has no task prompt (R0 F27). Stub (P2.5
 * red commit): every function records and finds nothing.
 */
import type { ActionClass } from "./memory-classes";

/** One launch, as `PreToolUse(Agent)` records it in the session's `spawn.log`. */
export interface Spawn {
  id: string;
  type: string;
  paths: string[];
  classes: ActionClass[];
  t: number;
}

/** A child window's scope: its task's paths and classes, or the parent's recent paths. */
export interface ChildScope {
  paths: string[];
  classes: ActionClass[];
  from: "task" | "parent";
}

export function taskPaths(_task: string, _top: string): string[] {
  return [];
}

export function spawnOf(_payload: Record<string, unknown>, _top: string, _now: number): Spawn | undefined {
  return undefined;
}

export function recordSpawn(_win: string, _spawn: Spawn): void {}

export function claimSpawn(
  _win: string,
  _want: { type: string; id?: string; now: number; agent: string; mark?: boolean },
): Spawn | undefined {
  return undefined;
}

export function storedScope(_win: string): ChildScope | undefined {
  return undefined;
}

export function storeScope(_win: string, _scope: ChildScope): void {}

export function agentClasses(_type: string): ActionClass[] {
  return [];
}

export function childTranscript(_r: Record<string, unknown>): string {
  return "";
}

export function launchToolUseId(_r: Record<string, unknown>): string | undefined {
  return undefined;
}
