"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { formatWindowShort } from "./dashboard-helpers";

/**
 * One diagnosis + one primary CTA (Wave 6 / 7).
 * Status → Diagnosis → one Action — diagnosis owns the decision.
 */
export function DiagnosisStrip({
  windowHours,
  anomalyCount,
  severityCounts,
  alertsUnavailable,
  topFailureModes,
  summaryUnavailable,
  summaryLoading,
  openIssueCount = 0,
}: {
  windowHours: number;
  anomalyCount: number;
  severityCounts: Record<string, number>;
  alertsUnavailable: boolean;
  topFailureModes: Array<{ name: string; count: number }>;
  summaryUnavailable: boolean;
  summaryLoading: boolean;
  openIssueCount?: number;
}) {
  const hasCritical = (severityCounts.critical ?? 0) > 0;
  const hasWarning = (severityCounts.warning ?? 0) > 0;
  const hasFailures = topFailureModes.length > 0;
  const hasOpenIssues = openIssueCount > 0;
  const tone =
    alertsUnavailable || summaryUnavailable
      ? "warning"
      : hasCritical
        ? "error"
        : hasWarning || hasFailures || hasOpenIssues
          ? "warning"
          : "ok";

  const title =
    alertsUnavailable || summaryUnavailable
      ? "Diagnosis incomplete"
      : hasCritical
        ? "Critical anomalies need attention"
        : hasOpenIssues
          ? "Open issues need triage"
          : hasFailures
            ? "Failure modes detected"
            : hasWarning
              ? "Warnings in the window"
              : "All systems normal";

  const detail =
    alertsUnavailable || summaryUnavailable
      ? "Some telemetry shards failed — retry from the banner above, or open Traces."
      : hasCritical || hasWarning
        ? `${anomalyCount} anomal${anomalyCount === 1 ? "y" : "ies"} in ${formatWindowShort(windowHours)}${
            hasFailures
              ? ` · top: ${topFailureModes[0]?.name ?? "—"}`
              : ""
          }`
        : hasOpenIssues
          ? `${openIssueCount} open issue${openIssueCount === 1 ? "" : "s"} — triage in Issues.`
          : hasFailures
            ? `${topFailureModes.length} failure mode${topFailureModes.length === 1 ? "" : "s"} in ${formatWindowShort(windowHours)}`
            : `No anomalies or failure modes in ${formatWindowShort(windowHours)}.`;

  // One Action — deepest relevant deep link only.
  const action =
    hasCritical || hasWarning || anomalyCount > 0
      ? { href: "/alerts", label: "Open Alerts" }
      : hasOpenIssues || hasFailures
        ? { href: "/issues", label: "Open Issues" }
        : { href: "/traces", label: "Open Traces" };

  return (
    <Panel
      tone="flat"
      padding="md"
      data-testid="dashboard-diagnosis"
      data-home-shell-diagnosis="one-cta"
      role="region"
      aria-labelledby="home-diagnosis-title"
      className={cn(
        "flex flex-col gap-space-3 sm:flex-row sm:items-center sm:justify-between",
        tone === "error" && "border-[var(--error)]/30",
        tone === "warning" && "border-[var(--warning)]/30",
        tone === "ok" && "border-[var(--border-subtle)]",
      )}
    >
      <div className="flex items-start gap-space-3 min-w-0">
        {tone === "ok" ? (
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-[var(--success)] mt-0.5"
            aria-hidden
          />
        ) : (
          <AlertTriangle
            className={cn(
              "h-5 w-5 shrink-0 mt-0.5",
              tone === "error"
                ? "text-[var(--error)]"
                : "text-[var(--warning-strong)]",
            )}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex flex-col gap-space-1">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)] m-0">
            Diagnosis
          </p>
          <h2
            id="home-diagnosis-title"
            className="text-base font-medium text-[var(--text-primary)] m-0 tracking-tight"
          >
            {summaryLoading ? "Checking status…" : title}
          </h2>
          <p className="text-sm text-[var(--text-secondary)] m-0">{detail}</p>
          {!summaryLoading && hasFailures ? (
            <ul className="mt-space-2 flex flex-col gap-space-1 m-0 p-0 list-none">
              {topFailureModes.slice(0, 3).map((mode) => (
                <li
                  key={mode.name}
                  className="flex items-center justify-between text-sm gap-space-4"
                >
                  <span className="text-[var(--text-primary)] truncate">
                    {mode.name}
                  </span>
                  <span className="text-[var(--text-muted)] shrink-0 font-mono text-xs">
                    {mode.count}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-space-2 shrink-0 sm:pl-space-4">
        <Button asChild size="sm" className="min-h-11">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      </div>
    </Panel>
  );
}
