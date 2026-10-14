/** D8's repo-fact mining (P3.4): a stub for the red-first commit; the implementation follows. */
import type { SlotId } from "./memory-slots";

export interface MinedFact {
  scope: string;
  slot: SlotId;
  value: string;
  files: string[];
}

export function exactVersion(_raw: string): string | undefined {
  return undefined;
}

export function mineFolder(_top: string, _scope: string): MinedFact[] {
  return [];
}

export function mineRepo(_top: string, _scopes: readonly string[]): MinedFact[] {
  return [];
}

export function minedText(_fact: Pick<MinedFact, "scope" | "slot" | "value" | "files">): string {
  return "";
}
