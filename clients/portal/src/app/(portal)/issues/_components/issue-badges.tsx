import { Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  IssuePriorityBadge,
  IssueWorkflowBadge,
} from "@/components/ui/status-badge";

export { IssuePriorityBadge as IssueSeverityBadge };
export { IssueWorkflowBadge as StatusBadge };

export function RepeatBadge({ count }: { count: number }) {
  return (
    <Badge
      variant="outline"
      title={`Regressed / re-occurred ${count} times`}
      className="gap-1 rounded-md font-semibold bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/30"
      role="status"
      aria-label={`Repeated ${count} times`}
    >
      <Repeat className="h-3 w-3" aria-hidden />×{count}
    </Badge>
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
    <Badge
      variant="outline"
      title={regressionCaseId ? `Regression case ${regressionCaseId}` : "Issue regressed after fix"}
      className="gap-1 rounded-md font-semibold bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30"
      role="status"
      aria-label="Regression"
    >
      Regression
    </Badge>
  );
}
