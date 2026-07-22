"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  composeGradeSummary,
  GRADE_LABELS,
  gradeChipClass,
  overallComparisonGrade,
  type ComparisonGrade,
  type Datapoint,
} from "@/lib/compare-grades";

export type CompareGradeHeaderProps = {
  summary?: Record<string, number> | null;
  datapoints?: Datapoint[];
  className?: string;
};

const GRADE_BADGE: Record<
  ComparisonGrade,
  "success" | "error" | "warning" | "outline"
> = {
  improve: "success",
  regress: "error",
  tradeoff: "warning",
  tie: "outline",
};

export function CompareGradeHeader({
  summary,
  datapoints = [],
  className,
}: CompareGradeHeaderProps) {
  const t = useTranslations("evals");
  const grades = composeGradeSummary(summary, datapoints);
  const overall = overallComparisonGrade(grades);

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-testid="compare-grade-header"
    >
      <span className="text-sm text-[var(--text-muted)]">
        {t("compare.overall")}
      </span>
      <Badge
        variant={GRADE_BADGE[overall]}
        className={cn("rounded-md", gradeChipClass(overall))}
        data-testid="compare-grade-overall"
      >
        {GRADE_LABELS[overall]}
      </Badge>
      {(Object.keys(GRADE_LABELS) as ComparisonGrade[]).map((g) => (
        <Badge
          key={g}
          variant="outline"
          className={cn("rounded-md", gradeChipClass(g))}
          data-testid={`compare-grade-count-${g}`}
        >
          {GRADE_LABELS[g]} {grades[g]}
        </Badge>
      ))}
    </div>
  );
}
