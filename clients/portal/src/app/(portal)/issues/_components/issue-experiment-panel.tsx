"use client";

import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { experimentHref } from "@/lib/portal-cross-links";

function ExperimentReportBanner({ report }: { report: Record<string, unknown> }) {
  const prob = Number(report.prob_treatment_better ?? 0);
  const rec = String(report.recommendation ?? "continue");
  const control = Number(report.control_stumble_rate ?? 0);
  const treatment = Number(report.treatment_stumble_rate ?? 0);
  const recColor =
    rec === "promote_treatment"
      ? "text-[var(--success)]"
      : rec === "insufficient_data"
        ? "text-[var(--text-muted)]"
        : "text-[var(--warning)]";
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
      <div className={`text-sm font-semibold ${recColor}`}>{rec.replace(/_/g, " ")}</div>
      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        <div>
          <div className="text-[var(--text-muted)]">P(treatment better)</div>
          <div className="font-mono">{(prob * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[var(--text-muted)]">Control stumble</div>
          <div className="font-mono">{(control * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[var(--text-muted)]">Treatment stumble</div>
          <div className="font-mono">{(treatment * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[var(--text-muted)]">Samples</div>
          <div className="font-mono">
            {String(report.n_control ?? 0)} / {String(report.n_treatment ?? 0)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function IssueExperimentPanel({
  issueId,
  experimentResult,
  experiments,
  experimentsError,
  busy,
  onCreateExperiment,
  onExperimentReport,
  onRetry,
}: {
  issueId?: string;
  experimentResult?: Record<string, unknown> | null;
  experiments: Record<string, unknown>[];
  experimentsError?: string | null;
  busy: boolean;
  onCreateExperiment: () => void;
  onExperimentReport: (linkId: string) => void;
  onRetry: () => void;
}) {
  const evalHref = experimentHref(undefined, issueId);

  return (
    <div
      className="space-y-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4"
      data-wave-e1-issue-experiment="panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="h-4 w-4" /> Experiments
        </h2>
        <Button
          size="sm"
          disabled={busy}
          onClick={onCreateExperiment}
          data-wave-e1-issue-experiment="primary-cta"
          data-testid="issue-run-experiment"
        >
          Run experiment
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Measure whether a fix reduced stumble rate. Offline compare lives under{" "}
        <Link href={evalHref} className="text-[var(--accent)] underline-offset-2 hover:underline">
          Evals → Experiments
        </Link>
        .
      </p>
      {experimentResult ? (
        <ExperimentReportBanner report={experimentResult} />
      ) : null}
      {experimentsError ? (
        <ErrorState
          size="sm"
          title="Experiments unavailable"
          message={experimentsError}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : experiments.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No experiments yet. Start one to measure if a fix reduced stumble rate.
        </p>
      ) : (
        <ul className="space-y-2">
          {experiments.map((e) => (
            <li
              key={String(e.id)}
              className="flex items-center justify-between gap-2 rounded border border-[var(--border-subtle)] p-2"
            >
              <span className="font-mono text-xs">{String(e.experiment_id)}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onExperimentReport(String(e.id))}
              >
                View report
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
