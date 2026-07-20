import { Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  IssuePriorityBadge,
  IssueWorkflowBadge,
} from "@/components/ui/status-badge";

export { IssuePriorityBadge as IssueSeverityBadge };
export { IssueWorkflowBadge as StatusBadge };

export function RepeatBadge({ count }: { count: number }) {
  return (
    <span
      title={`Regressed / re-occurred ${count} times`}
      className="inline-flex items-center gap-1 text-2xs font-semibold px-space-2 py-space-1 rounded border bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/30"
      role="status"
      aria-label={`Repeated ${count} times`}
    >
      <Repeat className="h-3 w-3" aria-hidden />×{count}
    </span>
  );
}

export function RegressionBadge({
  regressionCaseId,
  status,
}: {
  regressionCaseId?: string | null;
  status?: string;
}) {
  if (!regressionCaseId && status !== "regressed") return null;
  return (
    <span
      title={regressionCaseId ? `Regression case ${regressionCaseId}` : "Issue regressed after fix"}
      className="inline-flex items-center gap-1 text-2xs font-semibold px-space-2 py-space-1 rounded border bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30"
      role="status"
      aria-label="Regression"
    >
      Regression
    </span>
  );
}
