/**
 * The store's rule index (A4 §1 `policies.jsonl` and `intents.jsonl`; A7 §5 "Lookup"): the rule rows still in force,
 * so the PreToolUse guard reads two small files instead of the whole store. Rows whose every rule is an intent go to
 * `intents.jsonl`, the rest to `policies.jsonl`, each the newest 500. A line is the row as a delivery needs it (its
 * text, time, kind, tags, rule keys and `valid_until`).
 *
 * The store writes it under its own lock after each persist, from the rows it just wrote (`AgentMemory.persist`), and
 * only when it changed, each file under `<file>.lock` as `eden memory purge` rewrites it. Only typed rows carry rules
 * (D12), so the index holds only what the user typed. A row superseded since (L8) is left out; what a later
 * invalidation or 7 days take from a row is read at the guard (`memory-guard.ts`), as at every delivery point.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import type { MemoryRecord } from "./index";
import type { RuleRef } from "./memory-policy";

export const POLICIES_FILE = "policies.jsonl";
export const INTENTS_FILE = "intents.jsonl";
/** A7 §5: 500 live rows per repo and file. */
export const INDEX_CAP = 500;

export type IndexedRow = Pick<MemoryRecord, "id" | "text" | "kind" | "at" | "tags" | "rules" | "validUntil">;

/** Whether a row is superseded (A4 §3.1), read as `index.ts` reads it. */
function superseded(row: MemoryRecord): boolean {
  return typeof row.invalidAt === "number" || typeof row.invalidBy === "string";
}

function lineOf(row: MemoryRecord): string {
  const line: IndexedRow = { id: row.id, text: row.text, kind: row.kind, at: row.at, rules: row.rules };
  if (row.tags?.length) line.tags = row.tags;
  if (typeof row.validUntil === "number" && Number.isFinite(row.validUntil)) line.validUntil = row.validUntil;
  return JSON.stringify(line);
}

function contents(rows: readonly MemoryRecord[]): string {
  const newest = [...rows].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-INDEX_CAP);
  return newest.map((row) => `${lineOf(row)}\n`).join("");
}

function writeIfChanged(path: string, text: string): void {
  withFileLock(`${path}.lock`, () => {
    let now: string | undefined;
    try {
      now = readFileSync(path, "utf8");
    } catch {}
    if (now !== text) writeFileAtomic(path, text);
  });
}

/** Rewrites the index of a store from its rows (see the header). */
export function writeRuleIndex(dir: string, rows: readonly MemoryRecord[]): void {
  const ruled = rows.filter((row) => row.rules?.length && !superseded(row));
  const intent = (row: MemoryRecord) => row.rules!.every((rule) => rule.q !== undefined);
  writeIfChanged(join(dir, POLICIES_FILE), contents(ruled.filter((row) => !intent(row))));
  writeIfChanged(join(dir, INTENTS_FILE), contents(ruled.filter(intent)));
}

function parseRow(line: string): IndexedRow[] {
  try {
    const row = JSON.parse(line) as IndexedRow;
    const rules = Array.isArray(row.rules) ? row.rules.filter((rule: RuleRef) => typeof rule?.k === "string") : [];
    if (typeof row.id !== "string" || typeof row.text !== "string" || !rules.length) return [];
    return [{ ...row, rules }];
  } catch {
    return [];
  }
}

/** The index of a store: its policies, then its intents. Fails open to none. */
export function readRuleIndex(dir: string): IndexedRow[] {
  return [POLICIES_FILE, INTENTS_FILE].flatMap((name) => {
    try {
      return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).flatMap(parseRow);
    } catch {
      return [];
    }
  });
}
