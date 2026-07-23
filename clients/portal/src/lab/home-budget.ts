/**
 * Pure budget helpers for /home — avoids pulling cost driver fixtures.
 */

export type BudgetStatus = "ok" | "warn" | "breach";

/** Fraction of budget used. ≥ this → pressure (red). */
export const BUDGET_PRESSURE_RATIO = 0.8;

export function budgetRatio(spentUsd: number, limitUsd: number): number {
  if (limitUsd <= 0) return 0;
  return spentUsd / limitUsd;
}

export function budgetStatusFromSpend(
  spentUsd: number,
  limitUsd: number,
): BudgetStatus {
  const ratio = budgetRatio(spentUsd, limitUsd);
  if (ratio >= 1) return "breach";
  if (ratio >= BUDGET_PRESSURE_RATIO) return "warn";
  return "ok";
}

/** Near limit or over — both read as bad for color. */
export function budgetIsPressure(status: BudgetStatus): boolean {
  return status === "warn" || status === "breach";
}

export function budgetStatusLabel(status: BudgetStatus): string {
  if (status === "breach") return "Over budget";
  if (status === "warn") return "Near limit";
  return "On track";
}
