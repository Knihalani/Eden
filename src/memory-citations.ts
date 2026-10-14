/** D8's citations and D31's re-checks (P3.4): a stub for the red-first commit; the implementation follows. */
import type { AgentMemory, MemoryRecord } from "./index";
import type { MinedFact } from "./memory-repo-facts";
import type { SlotId } from "./memory-slots";

export interface Citation {
  scope: string;
  slot: SlotId;
  value: string;
  files: string[];
  checked: number;
}

export const WATCH_LIMIT = 200;

export function readCitations(_store: string): Citation[] {
  return [];
}

export interface CitationChanges {
  cite: MinedFact[];
  fail: Citation[];
  kept: Citation[];
}

export function citationChanges(
  _known: readonly Citation[],
  _mined: readonly MinedFact[],
  _rows: readonly MemoryRecord[],
  _now: number,
  _folders?: readonly string[],
): CitationChanges {
  return { cite: [], fail: [], kept: [] };
}

export function applyMined(
  _mem: AgentMemory,
  _mined: readonly MinedFact[],
  _folders?: readonly string[],
  _now?: number,
): Citation[] {
  return [];
}

export function scopesCiting(_citations: readonly Citation[], _rel: string): string[] {
  return [];
}

export function repoRelative(_top: string, _path: string): string | undefined {
  return undefined;
}

export function watchPaths(_citations: readonly Citation[], _top: string): string[] {
  return [];
}
