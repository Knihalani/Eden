/**
 * `arms.json`: per arm and flag state, whether it passes on today's plugin and, when not, the exact checks that
 * fail. The gate and the runner read it; only evidence edits it (EXECUTION X4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArmResult, FlagState } from "./kit";

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

/** The difference between a run and its record, in words; empty when they agree. */
export function mismatch(result: ArmResult, record: StateRecord): string {
  const unstable = new Set(record.unstable ?? []);
  const stable = (ids: readonly string[]) => ids.filter((id) => !unstable.has(id)).sort();
  const want = stable(record.state === "green" ? [] : (record.failed ?? []));
  const got = stable(result.failed);
  if (JSON.stringify(want) === JSON.stringify(got)) return "";
  const unexpected = got.filter((id) => !want.includes(id));
  const missing = want.filter((id) => !got.includes(id));
  const detail = result.checks
    .filter((item) => unexpected.includes(item.id) || missing.includes(item.id))
    .map((item) => `  ${item.ok ? "now passes" : "now fails"} ${item.id}: ${item.detail}`);
  return [
    `${result.arm} [${result.flags}] recorded ${record.state} ${JSON.stringify(want)}, ran ${JSON.stringify(got)}`,
    ...detail,
  ].join("\n");
}
