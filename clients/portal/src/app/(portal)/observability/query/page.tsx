"use client";

import { useState, useCallback } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import {
  columnarApi,
  dslApi,
  type DslAlertSeverity,
  type DslAlertSummary,
} from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { PageContent } from "@/components/layout/page-content";
import {
  ObserveBackToTraces,
  ObserveLeafHeader,
  WAVE10_SHELL_ATTR,
  WAVE_V3_8_POWER_ATTR,
} from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Search, Sparkles } from "lucide-react";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  CompileAlertCard,
  CompiledAlertsSidebar,
  QueryEditorCard,
  QueryResultsPanel,
  type ColumnarRunResult,
  type ParseData,
  type ResolveData,
} from "./_components/query-panels";
import type { DslLintWarning } from "@/lib/api";

const EXAMPLE_EQL = `SELECT trace_id FROM telemetry_events WHERE root.event_type = 'agent.run' AND any.error IS NOT NULL`;

function softFailureMessage(env: {
  status: string;
  message?: string;
}): string | null {
  if (env.status === "ok" || env.status === "ok_fallback") return null;
  if (env.status === "not_implemented") {
    return (
      env.message?.trim() ||
      "This operation is not available for the current query."
    );
  }
  return env.message?.trim() || `Request returned status "${env.status}"`;
}

export default function QueryDslPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [query, setQuery] = useState(EXAMPLE_EQL);
  const [activeOp, setActiveOp] = useState<
    "parse" | "lint" | "resolve" | "run" | null
  >(null);
  const [parseResult, setParseResult] = useState<ParseData | null>(null);
  const [lintWarnings, setLintWarnings] = useState<DslLintWarning[]>([]);
  const [lintEmptyOk, setLintEmptyOk] = useState(false);
  const [resolveResult, setResolveResult] = useState<ResolveData | null>(null);
  const [runResult, setRunResult] = useState<ColumnarRunResult | null>(null);
  const [error, setError] = useState("");
  const [lastOp, setLastOp] = useState<
    "parse" | "lint" | "resolve" | "run" | null
  >(null);
  const [alertName, setAlertName] = useState("Slow & low-judge trace");
  const [alertSeverity, setAlertSeverity] =
    useState<DslAlertSeverity>("high");
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
      const columns = dictRows.length > 0 ? Object.keys(dictRows[0]!) : [];
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
      <div
        {...WAVE10_SHELL_ATTR}
        {...WAVE_V3_8_POWER_ATTR}
        className="contents"
      >
        <ObserveBackToTraces />
        <ObserveLeafHeader
          title="Query"
          subtitle="EQL over the columnar engine — advanced under Traces More"
          icon={Sparkles}
        />
      </div>

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
          <QueryEditorCard
            query={query}
            onQueryChange={(q) => {
              setQuery(q);
              clearResults();
            }}
            activeOp={activeOp}
            onParse={runParse}
            onLint={runLint}
            onResolve={runResolve}
            onRun={runExecute}
          />
          <QueryResultsPanel
            parseResult={parseResult}
            lintEmptyOk={lintEmptyOk}
            lintWarnings={lintWarnings}
            resolveResult={resolveResult}
            runResult={runResult}
          />
          <CompileAlertCard
            alertName={alertName}
            alertSeverity={alertSeverity}
            compiling={compiling}
            compileResult={compileResult}
            onNameChange={setAlertName}
            onSeverityChange={setAlertSeverity}
            onCompile={handleCompileAlert}
          />
        </div>
        <div className="space-y-4">
          <CompiledAlertsSidebar
            alerts={alerts}
            alertsLoading={alertsLoading}
            alertsError={
              alertsQuery.isError
                ? alertsQuery.error instanceof Error
                  ? alertsQuery.error
                  : new Error("Failed to load alerts")
                : null
            }
            onRefresh={() => void loadAlerts()}
          />
        </div>
      </div>
    </PageContent>
  );
}
