/**
 * A6 §2.5's revocation proposal: a rule the user declined three times within 14 days is briefed at the next
 * SessionStart as `Rule you set: … (you declined it 3× — say "that rule is gone" to remove it)`, and "that rule is
 * gone" ends it.
 *
 * - **Declines.** A PostToolBatch, or sleep from the transcript, labels the guard's asks (`memory-guard-log.ts`). Each
 *   declined ask is appended to the repo store's `declines.jsonl`: the call's id, its time and the rules it showed, by
 *   `ruleIdentity` (ids only, X11). The store's, not the window's: the asks of every session of the repo count.
 * - **The count** is a rule's distinct declined calls of the last 14 days. A6 has sleep propose the revocation; the
 *   count is a read of this small log, so SessionStart makes it itself, from the same records, and no proposal file is
 *   kept.
 * - **Shown:** a SessionStart that delivered a proposal records its rules in the window's `ctx.log` (`revoke`), so the
 *   session's "that rule is gone" names them while the guard has asked nothing since (`memory-hook.ts` `endRules`).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryRecord } from "./index";
import { guardRecords, type Labelled } from "./memory-guard-log";
import { ruleClause, ruleIdentity } from "./memory-policy";
import type { ProvenanceNote } from "./memory-provenance";
import { appendRecord, parseRecords, windowRecords } from "./memory-window";

const DECLINES = "declines.jsonl";
/** A6 §2.5: three declined asks on one rule within 14 days. */
export const REVOKE_DECLINES = 3;
export const REVOKE_MS = 14 * 86_400_000;

/** Appends the declined asks among `labels` to the store's log (see the header). */
export function recordDeclines(store: string, labels: readonly Labelled[], now: number): void {
  const lines = labels
    .filter((item) => item.label === "declined" && item.rules.length)
    .map((item) => `${JSON.stringify({ t: now, id: item.id, rules: item.rules })}\n`);
  if (!lines.length) return;
  mkdirSync(store, { recursive: true, mode: 0o700 });
  appendFileSync(join(store, DECLINES), lines.join(""), { mode: 0o600 });
}

/** Each rule's distinct declined calls within the last 14 days, by `ruleIdentity`. */
export function declineCounts(store: string, now: number): Map<string, number> {
  let text = "";
  try {
    text = readFileSync(join(store, DECLINES), "utf8");
  } catch {
    return new Map();
  }
  const calls = new Map<string, Set<string>>();
  for (const record of parseRecords(text)) {
    const { t, id, rules } = record;
    if (typeof t !== "number" || typeof id !== "string" || !Array.isArray(rules) || now - t > REVOKE_MS) continue;
    for (const rule of rules) if (typeof rule === "string") calls.set(rule, (calls.get(rule) ?? new Set()).add(id));
  }
  return new Map([...calls].map(([rule, ids]) => [rule, ids.size]));
}

/**
 * The proposals to brief: for each rule declined 3 times within 14 days and still in force in `rows` (the rows the
 * repo reads, already through validity), its clause from the newest row stating it, worded as A6 §2.5 words it.
 */
export function revocationNotes<T extends Pick<MemoryRecord, "text" | "at" | "rules">>(
  rows: readonly T[],
  counts: ReadonlyMap<string, number>,
): (T & { revokes: string })[] {
  const notes: (T & { revokes: string })[] = [];
  for (const [rule, n] of counts) {
    if (n < REVOKE_DECLINES) continue;
    const row = rows.filter((r) => r.rules?.some((ref) => ruleIdentity(ref) === rule)).at(-1);
    const clause = row && ruleClause(row.text, rule);
    if (!row || !clause) continue;
    const text = `${clause} (you declined it ${n}× — say "that rule is gone" to remove it)`;
    notes.push({ ...row, text, rules: row.rules?.filter((ref) => ruleIdentity(ref) === rule), revokes: rule });
  }
  return notes;
}

/** Records the rules a SessionStart proposed revoking in the window (see the header). */
export function markRevocations(win: string, rules: readonly string[], now: number): void {
  if (rules.length) appendRecord(win, "ctx.log", { k: "revoke", rules: [...rules], t: now });
}

/** The rules this window was proposed to revoke, unless the guard has asked the user anything since. */
export function shownRevocations(win: string): string[] {
  const shown = windowRecords(win, "ctx.log").findLast((record) => record.k === "revoke");
  if (!shown || typeof shown.t !== "number" || !Array.isArray(shown.rules)) return [];
  const t = shown.t;
  if (guardRecords(win).some((record) => record.k === "call" && record.ask && record.t >= t)) return [];
  return shown.rules.filter((rule): rule is string => typeof rule === "string");
}

/** A briefed note that is a revocation proposal. */
export function isRevocation(note: ProvenanceNote): note is ProvenanceNote & { revokes: string } {
  return typeof (note as { revokes?: unknown }).revokes === "string";
}
