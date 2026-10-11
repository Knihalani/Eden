/** The store's rule index (A4 §1 `policies.jsonl`, `intents.jsonl`). Red first: nothing writes it yet. */
import type { MemoryRecord } from "./index";

export const POLICIES_FILE = "policies.jsonl";
export const INTENTS_FILE = "intents.jsonl";

export type IndexedRow = Pick<MemoryRecord, "id" | "text" | "kind" | "at" | "tags" | "rules" | "validUntil">;

export function readRuleIndex(_dir: string): IndexedRow[] {
  return [];
}
