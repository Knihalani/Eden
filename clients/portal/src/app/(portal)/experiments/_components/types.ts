/** Wave E4 — Experiments compare shared types. */

export type ExperimentRow = {
  id: string;
  name: string;
  dataset_id: string;
  status: string;
  source_issue_id?: string | null;
  created_at: string;
};

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

export type CompareMeta = {
  synthetic?: boolean;
  method?: string;
};

/** Braintrust-style comparison grades (composed from API fields — no new backend). */
export type ComparisonGrade = "improve" | "regress" | "tradeoff" | "tie";

export type CompareLayout = "summary" | "list" | "grid";

export type DiffMode = "base-comparison" | "expected-output";

export const COMPARE_LAYOUTS: CompareLayout[] = ["summary", "list", "grid"];

export const GRADE_LABELS: Record<ComparisonGrade, string> = {
  improve: "Improve",
  regress: "Regress",
  tradeoff: "Tradeoff",
  tie: "Tie",
};

export const BASELINE_PREF_KEY = "eden.experiments.baselineByDataset";
