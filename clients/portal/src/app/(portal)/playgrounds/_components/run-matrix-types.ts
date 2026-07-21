export type RunMatrixTask = {
  label?: string;
  model?: string;
  response?: string;
  cost_usd?: number;
};

export type RunMatrixRow = {
  row_id: string;
  input?: string;
  grade?: string;
  score_delta?: number;
  tasks?: RunMatrixTask[];
};

export type RunMatrix = {
  run_id?: string;
  cost_usd?: number;
  matrix?: RunMatrixRow[];
};

const FAIL_LIKE = new Set([
  "fail",
  "failed",
  "regress",
  "regression",
  "error",
]);

const PASS_LIKE = new Set(["improve", "pass", "ok"]);

function normalizeGrade(grade?: string): string {
  return (grade ?? "").trim().toLowerCase();
}

function gradeBucket(grade?: string): number {
  const g = normalizeGrade(grade);
  if (FAIL_LIKE.has(g)) return 0;
  if (PASS_LIKE.has(g)) return 2;
  return 1;
}

/** Promptfoo energy: failing / regressed rows first. */
export function sortMatrixFailingFirst(rows: RunMatrixRow[]): RunMatrixRow[] {
  return [...rows].sort((a, b) => {
    const failA = isFailingOrRegressedRow(a) ? 0 : 1;
    const failB = isFailingOrRegressedRow(b) ? 0 : 1;
    if (failA !== failB) return failA - failB;

    const bucket = gradeBucket(a.grade) - gradeBucket(b.grade);
    if (bucket !== 0) return bucket;

    const deltaA = a.score_delta ?? 0;
    const deltaB = b.score_delta ?? 0;
    if (deltaA !== deltaB) return deltaA - deltaB;

    return a.row_id.localeCompare(b.row_id);
  });
}

export function isFailingOrRegressedRow(row: RunMatrixRow): boolean {
  if (FAIL_LIKE.has(normalizeGrade(row.grade))) return true;
  return (row.score_delta ?? 0) < 0;
}
