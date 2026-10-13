/**
 * D7's slot table (P3.3). Stub for the red-first commit: the types the tests read, and no reading yet.
 */

export type SlotId =
  | "auth.provider"
  | "pkg.manager"
  | "db.engine"
  | "orm"
  | "test.runner"
  | "node.version"
  | "lang.version"
  | "framework"
  | "deploy.target"
  | "ci.system"
  | "formatter"
  | "linter"
  | "commit.style"
  | "branch.base"
  | "gh.account";

/** What one clause states of a slot: the value it sets, if any, and the values it invalidates. */
export interface SlotStatement {
  slot: SlotId;
  value?: string;
  was: string[];
}

/** A row's slots as it stores them (A4 §3.1): `v` the value it sets, `x` the values it invalidates. */
export interface SlotRef {
  k: SlotId;
  v?: string;
  x?: string[];
}

export const SLOT_IDS: readonly SlotId[] = [];
export const DEFAULT_SCOPES: Partial<Record<SlotId, "root" | "working">> = {};
export const STATUS_LEXICON: ReadonlySet<string> = new Set();

export function slotsIn(_text: string): SlotStatement[] {
  return [];
}
