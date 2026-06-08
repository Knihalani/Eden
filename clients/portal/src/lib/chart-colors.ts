/** Chart color values using CSS custom properties for dark-theme adaptability */
export const CHART_COLORS = {
  accent: "var(--chart-accent)",
  primary: "var(--chart-primary)",
  outcome: {
    gold: "var(--chart-outcome-gold)",
    silver: "var(--chart-outcome-silver)",
    bronze: "var(--chart-outcome-bronze)",
    partial: "var(--chart-outcome-partial)",
    failed: "var(--chart-outcome-failed)",
  },
  status: {
    pending: "var(--chart-label)",
    running: "var(--chart-accent)",
    completed: "var(--chart-success)",
    failed: "var(--chart-error)",
    human_review: "var(--chart-warning)",
    cancelled: "var(--chart-label)",
  },
  grid: "var(--chart-grid)",
  muted: "var(--chart-label)",
} as const;

export const STORAGE_COLORS = [
  "var(--chart-pie-1)",
  "var(--chart-pie-2)",
  "var(--chart-pie-3)",
  "var(--chart-pie-4)",
  "var(--chart-pie-5)",
] as const;

export function getOutcomeChartColor(tier: string): string {
  return CHART_COLORS.outcome[tier as keyof typeof CHART_COLORS.outcome] ?? CHART_COLORS.muted;
}
