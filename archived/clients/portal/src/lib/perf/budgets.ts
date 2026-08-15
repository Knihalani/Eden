/** F82 / A10 — Web Vitals budgets for Home + Traces (CI gate). */

export type WebVitalName = "LCP" | "INP" | "CLS" | "FCP" | "TTFB";

export interface VitalBudget {
  /** Regression threshold — CI fails when measured value exceeds this. */
  max: number;
  unit: "ms" | "score";
}

/**
 * Tightened July 2026 (A10 K43) from F82 dogfood baselines.
 * Adjust only with scorecard evidence.
 */
export const WEB_VITAL_BUDGETS: Record<WebVitalName, VitalBudget> = {
  LCP: { max: 2600, unit: "ms" },
  INP: { max: 220, unit: "ms" },
  CLS: { max: 0.1, unit: "score" },
  FCP: { max: 1800, unit: "ms" },
  TTFB: { max: 800, unit: "ms" },
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
