/**
 * Compose Braintrust-style comparison grades from existing compare payload.
 * Ported from pre-teardown experiments/_components/compare-grades.ts.
 */

export type ComparisonGrade = "improve" | "regress" | "tradeoff" | "tie";

export type Datapoint = {
  row_id?: string;
  grade?: string;
  score_delta?: number;
  control_score?: number;
  treatment_score?: number;
  control_output?: Record<string, unknown> | string;
  treatment_output?: Record<string, unknown> | string;
  expected_output?: Record<string, unknown> | string;
  input_data?: Record<string, unknown> | string;
  trace_id?: string;
};

const GRADE_ALIASES: Record<string, ComparisonGrade> = {
  improve: "improve",
  improvement: "improve",
  improved: "improve",
  regress: "regress",
  regression: "regress",
  regressed: "regress",
  tradeoff: "tradeoff",
  trade_off: "tradeoff",
  "trade-off": "tradeoff",
  tie: "tie",
  equal: "tie",
  unchanged: "tie",
};

export function normalizeComparisonGrade(
  raw?: string | null,
  scoreDelta?: number | null,
): ComparisonGrade {
  const key = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (key && GRADE_ALIASES[key]) return GRADE_ALIASES[key]!;
  if (key.includes("improv")) return "improve";
  if (key.includes("regress")) return "regress";
  if (key.includes("trade")) return "tradeoff";
  if (key.includes("tie") || key === "equal") return "tie";

  if (scoreDelta != null && Number.isFinite(scoreDelta)) {
    if (scoreDelta > 0.001) return "improve";
    if (scoreDelta < -0.001) return "regress";
    return "tie";
  }
  return "tie";
}

export function gradeFromDatapoint(dp: Datapoint): ComparisonGrade {
  return normalizeComparisonGrade(dp.grade, dp.score_delta);
}

/** Aggregate summary keys into canonical counts. */
export function composeGradeSummary(
  summary: Record<string, number> | null | undefined,
  datapoints: Datapoint[] = [],
): Record<ComparisonGrade, number> {
  const out: Record<ComparisonGrade, number> = {
    improve: 0,
    regress: 0,
    tradeoff: 0,
    tie: 0,
  };

  if (summary && Object.keys(summary).length > 0) {
    for (const [raw, count] of Object.entries(summary)) {
      const g = normalizeComparisonGrade(raw);
      out[g] += Number(count) || 0;
    }
    return out;
  }

  for (const dp of datapoints) {
    out[gradeFromDatapoint(dp)] += 1;
  }
  return out;
}

/** Overall verdict chip for a compare run vs baseline. */
export function overallComparisonGrade(
  grades: Record<ComparisonGrade, number>,
): ComparisonGrade {
  const improve = grades.improve;
  const regress = grades.regress;
  const tradeoff = grades.tradeoff;
  if (improve > 0 && regress > 0) return "tradeoff";
  if (tradeoff > 0 && improve === regress) return "tradeoff";
  if (improve > regress && improve > 0) return "improve";
  if (regress > improve && regress > 0) return "regress";
  if (tradeoff > 0) return "tradeoff";
  return "tie";
}

export function isFailingOrRegressedDatapoint(dp: Datapoint): boolean {
  const g = gradeFromDatapoint(dp);
  if (g === "regress") return true;
  const delta = Number(dp.score_delta ?? 0);
  return delta < -0.001;
}

export function filterFailingOrRegressedDatapoints(
  datapoints: Datapoint[],
): Datapoint[] {
  return datapoints.filter(isFailingOrRegressedDatapoint);
}

/** Regression-first: worst Δ first, then failing grades. */
export function sortDatapointsFailingFirst(datapoints: Datapoint[]): Datapoint[] {
  return [...datapoints].sort((a, b) => {
    const aFail = isFailingOrRegressedDatapoint(a) ? 0 : 1;
    const bFail = isFailingOrRegressedDatapoint(b) ? 0 : 1;
    if (aFail !== bFail) return aFail - bFail;
    return Number(a.score_delta ?? 0) - Number(b.score_delta ?? 0);
  });
}

export function deltaClassName(delta: number): string {
  if (delta > 0.001) return "text-[var(--success)]";
  if (delta < -0.001) return "text-[var(--error)]";
  return "text-[var(--text-muted)]";
}

export function gradeChipClass(grade: ComparisonGrade): string {
  switch (grade) {
    case "improve":
      return "border-[var(--success)]/40 bg-[var(--success-bg)] text-[var(--success)]";
    case "regress":
      return "border-[var(--error)]/40 bg-[var(--error-bg)] text-[var(--error)]";
    case "tradeoff":
      return "border-[var(--line)] bg-[var(--bg-inset)] text-[var(--text-muted)]";
    default:
      return "border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-muted)]";
  }
}

export const GRADE_LABELS: Record<ComparisonGrade, string> = {
  improve: "Improve",
  regress: "Regress",
  tradeoff: "Tradeoff",
  tie: "Tie",
};
