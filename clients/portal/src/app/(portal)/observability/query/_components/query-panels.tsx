"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Code2,
  ListChecks,
  Play,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { STICKY_FIRST_TD, STICKY_FIRST_TH } from "@/components/ui/table-sticky";
import { cn } from "@/lib/utils";
import type { DslAlertSeverity, DslAlertSummary, DslLintWarning } from "@/lib/api";

export type ParseData = {
  clickhouse_sql: string;
  shape: string;
  relational_fields_used: string[];
  warnings: DslLintWarning[];
};

export type ResolveData = {
  expanded_query: string;
  warnings: DslLintWarning[];
};

export type ColumnarRunResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  data_source: string;
};

export function LintRow({ warning: w }: { warning: DslLintWarning }) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 px-2.5 py-1.5 rounded-md text-xs",
        w.severity === "error"
          ? "bg-[var(--error-bg)] text-[var(--error)]"
          : w.severity === "warning"
            ? "bg-[var(--warning-bg)] text-[var(--warning)]"
            : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
      )}
    >
      <span className="font-mono text-2xs px-1.5 py-0.5 rounded bg-[var(--bg-base)]/40">
        {w.code}
      </span>
      <span className="font-medium uppercase text-2xs tracking-wide opacity-80">
        {w.severity}
      </span>
      <span className="flex-1">{w.message}</span>
    </li>
  );
}

export function ResultCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-[var(--accent)]" />
        {title}
      </h3>
      {children}
    </div>
  );
}

export function QueryEditorCard({
  query,
  onQueryChange,
  activeOp,
  onParse,
  onLint,
  onResolve,
  onRun,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  activeOp: "parse" | "lint" | "resolve" | "run" | null;
  onParse: () => void;
  onLint: () => void;
  onResolve: () => void;
  onRun: () => void;
}) {
  return (
    <Card padding="md" className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
        <Code2 className="w-4 h-4 text-[var(--accent)]" />
        EQL Query
      </h3>
      <textarea
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        spellCheck={false}
        className="w-full min-h-[120px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        placeholder="SELECT trace_id FROM telemetry_events WHERE root.event_type = 'agent.run'"
      />
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          variant="secondary"
          size="sm"
          className="min-h-11"
          onClick={onParse}
          disabled={activeOp !== null}
          loading={activeOp === "parse"}
        >
          <Code2 className="w-3.5 h-3.5" />
          Parse
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-11"
          onClick={onLint}
          disabled={activeOp !== null}
          loading={activeOp === "lint"}
        >
          <ListChecks className="w-3.5 h-3.5" />
          Lint
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-11"
          onClick={onResolve}
          disabled={activeOp !== null}
          loading={activeOp === "resolve"}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Resolve
        </Button>
        <Button
          variant="default"
          className="min-h-11"
          onClick={onRun}
          disabled={activeOp !== null}
          loading={activeOp === "run"}
        >
          <Play className="w-3.5 h-3.5" />
          Run
        </Button>
        <Link
          href="/observability/cohorts"
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline-offset-2 hover:underline ml-1"
        >
          Or run SQL in Columnar Engine →
        </Link>
      </div>
    </Card>
  );
}

export function QueryResultsPanel({
  parseResult,
  lintEmptyOk,
  lintWarnings,
  resolveResult,
  runResult,
}: {
  parseResult: ParseData | null;
  lintEmptyOk: boolean;
  lintWarnings: DslLintWarning[];
  resolveResult: ResolveData | null;
  runResult: ColumnarRunResult | null;
}) {
  return (
    <>
      {parseResult && (
        <ResultCard title="Parsed SQL" icon={Code2}>
          {(parseResult.warnings?.length ?? 0) === 0 ? (
            <p className="text-xs text-[var(--terminal)] flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="w-3.5 h-3.5" /> Valid
            </p>
          ) : (
            <p className="text-xs text-[var(--warning)] flex items-center gap-1.5 mb-2">
              <AlertTriangle className="w-3.5 h-3.5" />{" "}
              {parseResult.warnings.length} warning
              {parseResult.warnings.length === 1 ? "" : "s"}
            </p>
          )}
          <pre className="text-xs font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[300px]">
            {parseResult.clickhouse_sql}
          </pre>
          {parseResult.relational_fields_used.length > 0 && (
            <p className="text-xs text-[var(--text-muted)] mt-2">
              Relational fields: {parseResult.relational_fields_used.join(", ")}
            </p>
          )}
          {(parseResult.warnings?.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-1.5">
              {parseResult.warnings.map((w, i) => (
                <LintRow key={i} warning={w} />
              ))}
            </ul>
          )}
        </ResultCard>
      )}

      {lintEmptyOk && (
        <ResultCard title="Lint" icon={ListChecks}>
          <p className="text-xs text-[var(--terminal)] flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> No warnings
          </p>
        </ResultCard>
      )}

      {lintWarnings.length > 0 && (
        <ResultCard title="Lint Warnings" icon={ListChecks}>
          <ul className="space-y-1.5">
            {lintWarnings.map((w, i) => (
              <LintRow key={i} warning={w} />
            ))}
          </ul>
        </ResultCard>
      )}

      {resolveResult && (
        <ResultCard title="Resolved SQL" icon={Sparkles}>
          <pre className="text-xs font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto">
            {resolveResult.expanded_query}
          </pre>
          {(resolveResult.warnings?.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-1.5">
              {resolveResult.warnings.map((w, i) => (
                <LintRow key={i} warning={w} />
              ))}
            </ul>
          )}
        </ResultCard>
      )}

      {runResult && (
        <ResultCard title="Run results" icon={Play}>
          <p className="text-xs text-[var(--text-muted)] mb-2">
            {runResult.row_count} row{runResult.row_count === 1 ? "" : "s"}
            {runResult.data_source ? ` · ${runResult.data_source}` : ""}
          </p>
          <div className="overflow-x-auto max-h-[320px]">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-left text-[var(--text-muted)]">
                  {runResult.columns.map((c, colIdx) => (
                    <th
                      key={c}
                      className={cn(
                        "px-2 py-1 border-b border-[var(--border-default)] font-medium",
                        colIdx === 0 && STICKY_FIRST_TH,
                      )}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runResult.rows.slice(0, 50).map((row, i) => (
                  <tr key={i} className="text-[var(--text-secondary)]">
                    {runResult.columns.map((c, colIdx) => {
                      const cell = row[c];
                      return (
                        <td
                          key={c}
                          className={cn(
                            "px-2 py-1 border-b border-[var(--border-subtle)] truncate max-w-[220px]",
                            colIdx === 0 && STICKY_FIRST_TD,
                          )}
                        >
                          {cell === null || cell === undefined
                            ? "null"
                            : String(cell)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ResultCard>
      )}
    </>
  );
}

export function CompileAlertCard({
  alertName,
  alertSeverity,
  compiling,
  compileResult,
  onNameChange,
  onSeverityChange,
  onCompile,
}: {
  alertName: string;
  alertSeverity: DslAlertSeverity;
  compiling: boolean;
  compileResult: { alert_id: string; name: string; severity: string } | null;
  onNameChange: (v: string) => void;
  onSeverityChange: (v: DslAlertSeverity) => void;
  onCompile: () => void;
}) {
  return (
    <Card padding="md" className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
        <Bell className="w-4 h-4 text-[var(--accent)]" />
        Compile Alert
      </h3>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
            Name
          </label>
          <input
            type="text"
            value={alertName}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
            Severity
          </label>
          <select
            value={alertSeverity}
            onChange={(e) =>
              onSeverityChange(e.target.value as DslAlertSeverity)
            }
            className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
        </div>
      </div>
      <Button
        variant="default"
        className="min-h-11"
        onClick={onCompile}
        loading={compiling}
      >
        <Bell className="w-4 h-4" />
        Compile alert
      </Button>
      {compileResult && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs text-[var(--terminal)] flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Alert <span className="font-mono">{compileResult.alert_id}</span>{" "}
          compiled ({compileResult.severity})
        </div>
      )}
    </Card>
  );
}

export function CompiledAlertsSidebar({
  alerts,
  alertsLoading,
  alertsError,
  onRefresh,
}: {
  alerts: DslAlertSummary[];
  alertsLoading: boolean;
  alertsError: Error | null;
  onRefresh: () => void;
}) {
  return (
    <Card padding="lg" className="overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Bell className="w-4 h-4 text-[var(--accent)]" />
          Compiled Alerts
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          loading={alertsLoading}
          aria-label="Refresh compiled alerts"
        >
          Refresh
        </Button>
      </div>
      {alertsError ? (
        <ErrorState
          title="Could not load alerts"
          message={alertsError.message}
          action={
            <Button size="sm" variant="outline" onClick={onRefresh}>
              Try again
            </Button>
          }
        />
      ) : alertsLoading && alerts.length === 0 ? (
        <div className="space-y-3 px-4 py-6" aria-busy="true" aria-live="polite">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <Bell className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-40" />
          <p className="text-xs text-[var(--text-muted)]">No alerts yet</p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--border-subtle)]">
          {alerts.map((a) => (
            <div key={a.alert_id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                  {a.name}
                </span>
                <span
                  className={cn(
                    "text-2xs uppercase tracking-wide px-1.5 py-0.5 rounded-full font-medium flex-shrink-0",
                    a.severity === "critical"
                      ? "bg-[var(--error-bg)] text-[var(--error)]"
                      : a.severity === "high"
                        ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                        : a.severity === "warning"
                          ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                          : "bg-[var(--accent-faint)] text-[var(--accent)]",
                  )}
                >
                  {a.severity}
                </span>
              </div>
              <p className="text-2xs text-[var(--text-muted)] font-mono mt-0.5 truncate">
                {a.alert_id}
              </p>
              <p className="text-2xs text-[var(--text-muted)] mt-0.5">
                {a.last_fired_at
                  ? `Last fired ${new Date(a.last_fired_at).toLocaleString()}`
                  : "Never fired"}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
