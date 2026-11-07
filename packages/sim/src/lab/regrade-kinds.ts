/**
 * regrade.ts's split by task kind (fix-s3b): how often a second grader agrees with the run's own grader on hidden,
 * control and neutral tasks, and which way the disagreements go. A disagreement on hidden moves the recall figure; on
 * control and neutral it moves the false-concern rate, so the two directions are counted apart.
 */

export interface KindPair {
  kind: string;
  /** The second grader's verdict per fact (undefined when its call failed). */
  mine?: Record<string, boolean>;
  /** The run's grader's verdict per fact (undefined when the run left it ungraded). */
  run?: Record<string, boolean>;
}

export interface KindRow {
  /** Answers both graders graded. */
  answers: number;
  /** Facts both graded, and those where they agree. */
  facts: number;
  same: number;
  /** Facts only this grader called true, and only the run's grader. */
  onlyMine: number;
  onlyRun: number;
  /** Facts true by each grader: the rate each would report. */
  trueMine: number;
  trueRun: number;
}

export function byKind(pairs: readonly KindPair[]): Record<string, KindRow> {
  const out: Record<string, KindRow> = {};
  for (const p of pairs) {
    if (!p.mine || !p.run) continue;
    const row = (out[p.kind] ??= { answers: 0, facts: 0, same: 0, onlyMine: 0, onlyRun: 0, trueMine: 0, trueRun: 0 });
    row.answers++;
    for (const k of Object.keys(p.mine)) {
      if (!(k in p.run)) continue;
      const a = p.mine[k] === true;
      const b = p.run[k] === true;
      row.facts++;
      if (a === b) row.same++;
      else if (a) row.onlyMine++;
      else row.onlyRun++;
      if (a) row.trueMine++;
      if (b) row.trueRun++;
    }
  }
  return out;
}

/** Whether the run's grader called a control or neutral answer a concern (any fact true): `--only-concerns`. */
export function isConcern(kind: string, facts?: Record<string, boolean>): boolean {
  return (kind === "control" || kind === "neutral") && Object.values(facts ?? {}).some(Boolean);
}

/**
 * Whether the run's grader called a hidden answer a miss (no fact true): `--only-misses` (A2,
 * docs/research/a2-quality.md), a check of the hidden facts graded as not raised, which a weaker grader can miss.
 */
export function isMiss(kind: string, facts?: Record<string, boolean>): boolean {
  return kind === "hidden" && !Object.values(facts ?? {}).some(Boolean);
}
