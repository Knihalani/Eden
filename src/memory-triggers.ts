/** P2.2's compiled triggers (A7 §5, D18): a stub until the slice builds them. */
import type { ActionClass } from "./memory-classes";
import type { MemoryRecord } from "./index";

/** A7 §5: what one fired class delivers at most. */
export const PER_CLASS = 2;

export function firedClasses(_prompt: string): ActionClass[] {
  return [];
}

export function triggeredRows(_rows: readonly MemoryRecord[], _classes: readonly ActionClass[]): MemoryRecord[] {
  return [];
}
