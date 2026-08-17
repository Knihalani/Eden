/**
 * Quality scoring that can actually fail.
 *
 * Eden's existing scorer awarded 3/3 to both arms on every case of every bench
 * — including the run where the compiled tool invented every field it returned
 * ("Fix deploy for 166 | 6 | pending" against a gold of
 * "feat(help): find the file from leftover text | 1 | failure"). A metric that
 * saturates at full marks whatever happens is not a metric, and it is why
 * "quality tied" appears next to every result in the repo.
 *
 * Two rules make it discriminate:
 *
 *   1. Credit is per required field, not per task, so partial coverage scores
 *      partially. The product bench's tool returned 3 of 5 required fields and
 *      still scored full marks.
 *   2. A field stated *wrongly* is worse than a field omitted. Omission leaves
 *      the agent to go and fetch it; a confident wrong value is what actually
 *      corrupts an answer, so it is scored below zero for that field and
 *      surfaced by name.
 */

export type FieldSpec = {
  name: string;
  /** Absent from the answer ⇒ scores zero for this field. */
  required?: boolean;
  /** Defaults to a normalised loose equality. */
  equals?: (actual: unknown, expected: unknown) => boolean;
};

export type FieldOutcome = "correct" | "wrong" | "missing" | "extra";

export type RecordScore = {
  score: number;
  max: number;
  fields: Array<{ name: string; outcome: FieldOutcome; actual?: unknown; expected?: unknown }>;
  fabricated: string[];
  missing: string[];
};

/** Numbers, numeric strings and case/space differences should not count as disagreement. */
export function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual == null || expected == null) return false;
  if (typeof actual === "number" || typeof expected === "number") {
    const a = Number(actual);
    const b = Number(expected);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  const norm = (v: unknown) => String(v).trim().toLowerCase().replace(/\s+/g, " ");
  return norm(actual) === norm(expected);
}

/**
 * Score one record against gold.
 *
 * `wrongPenalty` is subtracted per fabricated field. It defaults to a full
 * field's worth, so a record that states half its fields wrongly cannot come
 * out ahead of one that simply omitted them.
 */
export function scoreRecord(
  answer: Record<string, unknown> | null | undefined,
  gold: Record<string, unknown>,
  spec: readonly FieldSpec[],
  opts: { wrongPenalty?: number } = {},
): RecordScore {
  const wrongPenalty = opts.wrongPenalty ?? 1;
  const fields: RecordScore["fields"] = [];
  const fabricated: string[] = [];
  const missing: string[] = [];
  let score = 0;
  let max = 0;

  for (const f of spec) {
    const expected = gold[f.name];
    if (expected === undefined) continue; // gold says nothing; nothing to score
    max += 1;
    const present = answer != null && Object.hasOwn(answer, f.name) && answer[f.name] != null;
    if (!present) {
      fields.push({ name: f.name, outcome: "missing", expected });
      missing.push(f.name);
      continue;
    }
    const actual = answer[f.name];
    const eq = (f.equals ?? looseEquals)(actual, expected);
    if (eq) {
      score += 1;
      fields.push({ name: f.name, outcome: "correct", actual, expected });
    } else {
      score -= wrongPenalty;
      fabricated.push(f.name);
      fields.push({ name: f.name, outcome: "wrong", actual, expected });
    }
  }
  return { score, max, fields, fabricated, missing };
}

export type SuiteScore = {
  score: number;
  max: number;
  /** score / max, floored at zero so a fabricating run reads as 0%, not negative. */
  fraction: number;
  fabricatedFields: number;
  missingFields: number;
  missingRecords: number;
  /** True if anything was stated wrongly. A run that fabricates never "ties". */
  fabricated: boolean;
  perRecord: RecordScore[];
};

/**
 * Score a list of records against gold, matched by `keyField`.
 *
 * A gold record with no answer counts as every field missing, so dropping rows
 * cannot raise the average — the failure mode of any per-row mean.
 */
export function scoreRecords(
  answers: ReadonlyArray<Record<string, unknown>>,
  gold: ReadonlyArray<Record<string, unknown>>,
  spec: readonly FieldSpec[],
  opts: { keyField?: string; wrongPenalty?: number } = {},
): SuiteScore {
  const keyField = opts.keyField ?? "id";
  const byKey = new Map<string, Record<string, unknown>>();
  for (const a of answers) {
    const k = a[keyField];
    if (k != null) byKey.set(String(k), a);
  }
  const perRecord: RecordScore[] = [];
  let missingRecords = 0;
  for (const g of gold) {
    const answer = byKey.get(String(g[keyField]));
    if (!answer) missingRecords++;
    perRecord.push(scoreRecord(answer, g, spec, opts));
  }
  const score = perRecord.reduce((s, r) => s + r.score, 0);
  const max = perRecord.reduce((s, r) => s + r.max, 0);
  const fabricatedFields = perRecord.reduce((s, r) => s + r.fabricated.length, 0);
  const missingFields = perRecord.reduce((s, r) => s + r.missing.length, 0);
  return {
    score,
    max,
    fraction: max ? Math.max(0, score / max) : 0,
    fabricatedFields,
    missingFields,
    missingRecords,
    fabricated: fabricatedFields > 0,
    perRecord,
  };
}
