import { Repeat } from "lucide-react";
import { cn } from "@/lib/utils";

export function IssueSeverityBadge({ severity }: { severity: string }) {
  const colorMap: Record<string, string> = {
    p0: "bg-[var(--error)]/20 text-[var(--error)] border-[var(--error)]/30",
    p1: "bg-[var(--warning)]/20 text-[var(--warning)] border-[var(--warning)]/30",
    p2: "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/30",
    p3: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border",
        colorMap[severity] ?? colorMap.p3,
      )}
    >
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    open: "bg-[var(--warning)]/20 text-[var(--warning)] border-[var(--warning)]/30",
    triaged: "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/30",
    fix_pending: "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/30",
    verifying: "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/30",
    resolved: "bg-[var(--terminal)]/20 text-[var(--terminal)] border-[var(--terminal)]/30",
    regressed: "bg-[var(--error)]/20 text-[var(--error)] border-[var(--error)]/30",
    ignored: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border",
        colorMap[status] ?? "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function RepeatBadge({ count }: { count: number }) {
  return (
    <span
      title={`Regressed / re-occurred ${count} times`}
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/30"
    >
      <Repeat className="h-3 w-3" />×{count}
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
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30"
    >
      Regression
    </span>
  );
}
