/**
 * `arms.json`: per arm and flag state, whether it passes on today's plugin and, when not, the exact checks that
 * fail. The gate and the runner read it; only evidence edits it (EXECUTION X4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlagState } from "./kit";

export interface StateRecord {
  state: "red" | "green";
  /** For a red state: the ids of the failing checks, sorted. */
  failed?: string[];
  why?: string;
  /** Checks today's plugin flips between identical runs; the gate leaves them out (gate.ts). */
  unstable?: string[];
}

export interface ArmRecord {
  id: string;
  group: string;
  /** The slices whose PROGRESS gate cites the arm. */
  slices: string[];
  /** The arm's A5 §4 text. */
  a5: string;
  on: StateRecord;
  off?: StateRecord;
  shadow?: StateRecord;
}

export interface Record_ {
  about: string;
  arms: ArmRecord[];
}

export const RECORD_PATH = join(import.meta.dir, "..", "arms.json");

export function loadRecord(path = RECORD_PATH): Record_ {
  return JSON.parse(readFileSync(path, "utf8")) as Record_;
}

/** The flag states recorded for an arm, `on` first. */
export function statesOf(record: Record_, id: string): FlagState[] {
  const entry = record.arms.find((arm) => arm.id === id);
  if (!entry) throw new Error(`arms.json has no arm ${id}`);
  return (["on", "off", "shadow"] as const).filter((state) => entry[state] !== undefined);
}

/** The failing checks a state is recorded with: [] for green; null when red has no measured set yet. */
export function expected(record: Record_, id: string, state: FlagState): string[] | null {
  const entry = record.arms.find((arm) => arm.id === id)?.[state];
  if (!entry) return null;
  if (entry.state === "green") return [];
  return entry.failed ? [...entry.failed].sort() : null;
}
