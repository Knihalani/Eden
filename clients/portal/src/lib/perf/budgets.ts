/** F82 — Web Vitals budgets for Home + Traces (CI gate). */

export type WebVitalName = "LCP" | "INP" | "CLS" | "FCP" | "TTFB";

export interface VitalBudget {
  /** Regression threshold — CI fails when measured value exceeds this. */
  max: number;
  unit: "ms" | "score";
}

/** Baseline from July 2026 dogfood; adjust only with scorecard evidence. */
export const WEB_VITAL_BUDGETS: Record<WebVitalName, VitalBudget> = {
  LCP: { max: 2800, unit: "ms" },
  INP: { max: 250, unit: "ms" },
  CLS: { max: 0.12, unit: "score" },
  FCP: { max: 2000, unit: "ms" },
  TTFB: { max: 900, unit: "ms" },
};

export const F82_CORE_ROUTES = ["/dashboard", "/traces"] as const;

export interface VitalSample {
  route: string;
  name: WebVitalName;
  value: number;
}

export function exceedsBudget(sample: VitalSample): boolean {
  const budget = WEB_VITAL_BUDGETS[sample.name];
  if (!budget) return false;
  return sample.value > budget.max;
}

export function budgetFailures(samples: VitalSample[]): VitalSample[] {
  return samples.filter(exceedsBudget);
}
