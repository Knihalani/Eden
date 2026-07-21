"use client";

export type StudioTab = "templates" | "examples" | "metrics";

export interface ExampleRow {
  input: string;
  output: string;
  label: "pass" | "fail";
  rationale: string;
}

export type TemplateSeed = {
  name: string;
  domain: string;
  notes?: string;
};

/** Mirror of studio metrics empty gate — keep in sync with MyMetricsTab. */
export function showStudioMetricsEmpty(opts: {
  loading: boolean;
  hasError: boolean;
  metricCount: number;
}): boolean {
  return !opts.loading && !opts.hasError && opts.metricCount === 0;
}

/** True when From-examples work should block navigation without confirm. */
export function studioExamplesIsDirty(opts: {
  generated: boolean;
  name: string;
  examples: ExampleRow[];
}): boolean {
  if (opts.generated) return true;
  if (opts.name.trim()) return true;
  return opts.examples.some(
    (e) => e.input.trim() || e.output.trim() || e.rationale.trim(),
  );
}

export function isProduction(status: string | undefined): boolean {
  return status === "production";
}

export function blankExamples(): ExampleRow[] {
  return [
    { input: "", output: "", label: "pass", rationale: "" },
    { input: "", output: "", label: "fail", rationale: "" },
  ];
}
