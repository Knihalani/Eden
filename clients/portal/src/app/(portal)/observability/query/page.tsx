"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import {
  columnarApi,
  dslApi,
  type DslAlertSeverity,
  type DslAlertSummary,
  type DslLintWarning,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContent } from "@/components/layout/page-content";
import { ObserveLeafHeader } from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Search, Code2, AlertTriangle, CheckCircle2, Sparkles, ListChecks, Bell, Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { STICKY_FIRST_TD, STICKY_FIRST_TH } from "@/components/ui/table-sticky";
import { errorFromCaught } from "@/lib/safe-error-message";

// Valid leading SELECT example from docs/docs/observability/19-trace-query-dsl.md
const EXAMPLE_EQL = `SELECT trace_id FROM telemetry_events WHERE root.event_type = 'agent.run' AND any.error IS NOT NULL`;

type ParseData = {
  clickhouse_sql: string;
  shape: string;
  relational_fields_used: string[];
  warnings: DslLintWarning[];
};
type ResolveData = {
  expanded_query: string;
  warnings: DslLintWarning[];
};
type ColumnarRunResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  data_source: string;
};

function softFailureMessage(env: { status: string; message?: string }): string | null {
  if (env.status === "ok" || env.status === "ok_fallback") return null;
  if (env.status === "not_implemented") {
    return env.message?.trim() || "This operation is not available for the current query.";
  }
  return env.message?.trim() || `Request returned status "${env.status}"`;
}

export default function QueryDslPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [query, setQuery] = useState(EXAMPLE_EQL);
  const [activeOp, setActiveOp] = useState<"parse" | "lint" | "resolve" | "run" | null>(null);
  const [parseResult, setParseResult] = useState<ParseData | null>(null);
  const [lintWarnings, setLintWarnings] = useState<DslLintWarning[]>([]);
  const [lintEmptyOk, setLintEmptyOk] = useState(false);
  const [resolveResult, setResolveResult] = useState<ResolveData | null>(null);
  const [runResult, setRunResult] = useState<ColumnarRunResult | null>(null);
  const [error, setError] = useState("");
  const [lastOp, setLastOp] = useState<"parse" | "lint" | "resolve" | "run" | null>(null);

  const [alertName, setAlertName] = useState("Slow & low-judge trace");
  const [alertSeverity, setAlertSeverity] = useState<DslAlertSeverity>("high");
  const [compileResult, setCompileResult] = useState<{
    alert_id: string;
    name: string;
    severity: string;
  } | null>(null);
  const [compiling, setCompiling] = useState(false);

  const orgId = currentOrg?.id ?? null;
  const alertsQuery = useOrgQuery(
    queryKeys.dslAlerts.list(orgId),
    orgId,
    async () => {
      const env = await dslApi.listAlerts(orgId!);
      const soft = softFailureMessage(env);
      if (soft) throw new Error(soft);
      return env.data?.alerts ?? [];
    },
  );
  const alerts: DslAlertSummary[] = alertsQuery.data ?? [];
  const alertsLoading = alertsQuery.isLoading;
  const loadAlerts = useCallback(async () => {
    await alertsQuery.refetch();
  }, [alertsQuery]);

  function clearResults() {
    setParseResult(null);
    setLintWarnings([]);
    setLintEmptyOk(false);
    setResolveResult(null);
    setRunResult(null);
    setError("");
  }

  async function runParse() {
    if (!currentOrg) return;
    setActiveOp("parse");
    setLastOp("parse");
    setError("");
    setParseResult(null);
    try {
      const env = await dslApi.parse(currentOrg.id, { query });
      const soft = softFailureMessage(env);
      if (soft) {
        setError(soft);
        return;
      }
      if (!env.data) {
        setError("Parse returned an empty payload");
        return;
      }
      setParseResult(env.data);
    } catch (err) {
      setError(errorFromCaught(err, "Parse failed"));
    } finally {
      setActiveOp(null);
    }
  }

  async function runLint() {
    if (!currentOrg) return;
    setActiveOp("lint");
    setLastOp("lint");
    setError("");
    setLintWarnings([]);
    setLintEmptyOk(false);
    try {
      const env = await dslApi.lint(currentOrg.id, { query });
      const soft = softFailureMessage(env);
      if (soft) {
        setError(soft);
        return;
      }
      const warnings = env.data?.warnings ?? [];
      setLintWarnings(warnings);
      setLintEmptyOk(warnings.length === 0);
    } catch (err) {
      setError(errorFromCaught(err, "Lint failed"));
    } finally {
      setActiveOp(null);
    }
  }

  async function runResolve() {
    if (!currentOrg) return;
    setActiveOp("resolve");
    setLastOp("resolve");
    setError("");
    setResolveResult(null);
    try {
      const env = await dslApi.resolve(currentOrg.id, { query });
      const soft = softFailureMessage(env);
      if (soft) {
        setError(soft);
        return;
      }
      if (!env.data) {
        setError("Resolve returned an empty payload");
        return;
      }
      setResolveResult(env.data);
    } catch (err) {
      setError(errorFromCaught(err, "Resolve failed"));
    } finally {
      setActiveOp(null);
    }
  }

  async function runExecute() {
    if (!currentOrg) return;
    setActiveOp("run");
    setLastOp("run");
    setError("");
    setRunResult(null);
    try {
      const env = await dslApi.resolve(currentOrg.id, { query });
      const soft = softFailureMessage(env);
      if (soft) {
        setError(soft);
        return;
      }
      const sql = env.data?.expanded_query?.trim();
      if (!sql) {
        setError("Resolve did not return SQL to execute");
        return;
      }
      setResolveResult(env.data);
      const col = await columnarApi.query(currentOrg.id, { query: sql });
      const colSoft = softFailureMessage(col);
      if (colSoft) {
        setError(colSoft);
        return;
      }
      if (!col.data) {
        setError("Columnar query returned an empty payload");
        return;
      }
      const dictRows = col.data.rows ?? [];
      const columns =
        dictRows.length > 0
          ? Object.keys(dictRows[0]!)
          : [];
      setRunResult({
        columns,
        rows: dictRows,
        row_count: col.data.n_rows ?? dictRows.length,
        data_source: col.data.data_source,
      });
    } catch (err) {
      setError(errorFromCaught(err, "Run failed"));
    } finally {
      setActiveOp(null);
    }
  }

  async function handleCompileAlert() {
    if (!currentOrg) return;
    if (!alertName.trim()) {
      toast.error("Alert name is required");
      return;
    }
    setCompiling(true);
    try {
      const env = await dslApi.compileAlert(currentOrg.id, {
        eql_query: query,
        name: alertName,
        severity: alertSeverity,
      });
      const soft = softFailureMessage(env);
      if (soft) {
        toast.error(soft);
        setError(soft);
        return;
      }
      if (!env.data) {
        toast.error("Compile returned an empty payload");
        return;
      }
      setCompileResult({
        alert_id: env.data.alert_id,
        name: env.data.name,
        severity: env.data.severity,
      });
      toast.success(`Alert compiled — ${env.data.alert_id.slice(0, 12)}…`);
      await loadAlerts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Compile failed");
    } finally {
      setCompiling(false);
    }
  }

  function retryLastOp() {
    if (lastOp === "parse") void runParse();
    else if (lastOp === "lint") void runLint();
    else if (lastOp === "resolve") void runResolve();
    else if (lastOp === "run") void runExecute();
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Search}
        feature="Trace Query DSL"
        description="Parse, lint, and resolve Eden Query Language (EQL) expressions once your org is configured."
      />
    );
  }

  return (
    <PageContent size="wide">
      <ObserveLeafHeader
        title="Query"
        subtitle="Trace Query DSL with EQL syntax over the columnar engine"
        icon={Sparkles}
      />

      {error ? (
        <ErrorState
          title="Could not run query"
          message={error}
          action={
            lastOp ? (
              <Button size="sm" variant="outline" onClick={retryLastOp}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <div className="grid lg:grid-cols-3 gap-space-5">
        <div className="lg:col-span-2 space-y-space-4">
          <Card padding="md" className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Code2 className="w-4 h-4 text-[var(--accent)]" />
              EQL Query
            </h3>
            <textarea
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                clearResults();
              }}
              spellCheck={false}
              className="w-full min-h-[120px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              placeholder="SELECT trace_id FROM telemetry_events WHERE root.event_type = 'agent.run'"
            />
            <div className="flex flex-wrap gap-2 items-center">
              <Button variant="secondary" size="sm" className="min-h-11" onClick={runParse} disabled={activeOp !== null} loading={activeOp === "parse"}>
            <Code2 className="w-3.5 h-3.5" />
            Parse
          </Button>
              <Button variant="secondary" size="sm" className="min-h-11" onClick={runLint} disabled={activeOp !== null} loading={activeOp === "lint"}>
            <ListChecks className="w-3.5 h-3.5" />
            Lint
          </Button>
              <Button variant="secondary" size="sm" className="min-h-11" onClick={runResolve} disabled={activeOp !== null} loading={activeOp === "resolve"}>
            <Sparkles className="w-3.5 h-3.5" />
            Resolve
          </Button>
              <Button variant="default" className="min-h-11" onClick={runExecute} disabled={activeOp !== null} loading={activeOp === "run"}>
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

          {parseResult && (
            <ResultCard title="Parsed SQL" icon={Code2}>
              {(parseResult.warnings?.length ?? 0) === 0 ? (
                <p className="text-xs text-[var(--terminal)] flex items-center gap-1.5 mb-2">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Valid
                </p>
              ) : (
                <p className="text-xs text-[var(--warning)] flex items-center gap-1.5 mb-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> {parseResult.warnings.length} warning
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
                              {cell === null || cell === undefined ? "null" : String(cell)}
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
                  onChange={(e) => setAlertName(e.target.value)}
                  className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
                  Severity
                </label>
                <select
                  value={alertSeverity}
                  onChange={(e) => setAlertSeverity(e.target.value as DslAlertSeverity)}
                  className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
                >
                  <option value="info">info</option>
                  <option value="warning">warning</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </div>
            </div>
            <Button variant="default" className="min-h-11" onClick={handleCompileAlert} loading={compiling}>
            <Bell className="w-4 h-4" />
            Compile alert
          </Button>

            {compileResult && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs text-[var(--terminal)] flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Alert <span className="font-mono">{compileResult.alert_id}</span> compiled ({compileResult.severity})
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card padding="lg" className="overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Bell className="w-4 h-4 text-[var(--accent)]" />
                Compiled Alerts
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={loadAlerts}
                loading={alertsLoading}
                aria-label="Refresh compiled alerts"
              >
                Refresh
              </Button>
            </div>
            {alertsQuery.isError ? (
              <ErrorState
                title="Could not load alerts"
                message={
                  alertsQuery.error instanceof Error
                    ? alertsQuery.error.message
                    : "Failed to load alerts"
                }
                action={
                  <Button size="sm" variant="outline" onClick={() => void loadAlerts()}>
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
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">{a.name}</span>
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
                    <p className="text-2xs text-[var(--text-muted)] font-mono mt-0.5 truncate">{a.alert_id}</p>
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
        </div>
      </div>
    </PageContent>
  );
}

function LintRow({ warning: w }: { warning: DslLintWarning }) {
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
      <span className="font-mono text-2xs px-1.5 py-0.5 rounded bg-[var(--bg-base)]/40">{w.code}</span>
      <span className="font-medium uppercase text-2xs tracking-wide opacity-80">{w.severity}</span>
      <span className="flex-1">{w.message}</span>
    </li>
  );
}

function ResultCard({
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
