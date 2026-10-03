/**
 * Annotated cues (A5 §3.6): every scripted human prompt says which world items its turn needs and which
 * others a packet may carry without being false. A subagent launch may carry the same annotation for its
 * SubagentStart packet. Items are named `key@scope` (oracle.ts); there is no judge.
 */
import { parseItemId, type Oracle } from "./oracle";
import type { WindowSnapshot } from "./window";

export interface Cue {
  /** Items the turn needs (`need_miss_rate`): `key@scope` is the value of `key` as seen from `scope`. */
  needs: string[];
  /** Items a packet may also carry (`false_rate`: a bullet outside `needs ∪ allowed` is false). */
  allowed: string[];
  /** The scope the user works in. A bullet that names no scope is read as about this one. */
  scope: string;
  /** The turn mode where the script knows it (A7 §2). Packets on `ack` turns break silence. */
  mode?: "ack" | "continuation";
}

/** An annotated cue as it happened: where, when, and what the window held when the packet arrived. */
export interface CueRecord {
  cue: Cue;
  /** The prompt, or the subagent's task. */
  text: string;
  /** The event that delivers its packet: UserPromptSubmit, or SubagentStart. */
  seq: number;
  sessionId: string;
  window: string;
  /** The window with the prompt (or task) in it and before the packet. */
  seen: WindowSnapshot;
}

/** A cue for a turn that needs nothing and allows nothing: any bullet on it is false. */
export function plainCue(scope = "", mode?: Cue["mode"]): Cue {
  return { needs: [], allowed: [], scope, ...(mode ? { mode } : {}) };
}

/** Throws unless every item the cue names belongs to a subject of the world. */
export function checkCue(cue: Cue, oracle: Oracle): void {
  for (const id of [...cue.needs, ...cue.allowed]) oracle.subject(parseItemId(id).key);
}
