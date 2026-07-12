"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Alert } from "@/components/ui/alert";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Search, Loader2, Code2, AlertTriangle, CheckCircle2, Sparkles, ListChecks, Bell } from "lucide-react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";
const EXAMPLE_EQL = `root.span.duration_ms > 1000 AND any.judge.score < 0.5`;
interface ParseResult {
  ast: Record<string, unknown>;
  valid: boolean;
  errors: string[];
}
interface LintWarning {
  line: number;
  column: number;
  severity: string;
  message: string;
}
interface ResolveResult {
  sql: string;
  parameters: Record<string, unknown>;
}
interface AlertSummary {
  alert_id: string;
  name: string;
  severity: string;
  created_at: string;
  last_fired: string | null;
}
interface CompileAlertResult {
  alert_id: string;
  name: string;
  sql: string;
  severity: string;
}
function parseQuery(orgId: string, query: string): Promise<ParseResult> {
  return api.post<ParseResult>(`/orgs/${orgId}/intelligence/dsl/parse`, {
    query
  });
}
function lintQuery(orgId: string, query: string): Promise<{
  warnings: LintWarning[];
}> {
  return api.post<{
    warnings: LintWarning[];
  }>(`/orgs/${orgId}/intelligence/dsl/lint`, {
    query
  });
}
function resolveQuery(orgId: string, query: string): Promise<ResolveResult> {
  return api.post<ResolveResult>(`/orgs/${orgId}/intelligence/dsl/resolve`, {
    query
  });
}
function compileAlert(orgId: string, query: string, name: string, severity: string): Promise<CompileAlertResult> {
  return api.post<CompileAlertResult>(`/orgs/${orgId}/intelligence/dsl/alerts/compile`, {
    query,
    name,
    severity
  });
}
function listAlerts(orgId: string): Promise<{
  alerts: AlertSummary[];
}> {
  return api.get<{
    alerts: AlertSummary[];
  }>(`/orgs/${orgId}/intelligence/dsl/alerts`);
}
export default function QueryDslPage() {
  const {
    currentOrg
  } = useOrg();
  const toast = useToast();
  const [query, setQuery] = useState(EXAMPLE_EQL);
  const [activeOp, setActiveOp] = useState<"parse" | "lint" | "resolve" | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [lintWarnings, setLintWarnings] = useState<LintWarning[]>([]);
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);
  const [error, setError] = useState("");

  // Compile alert
  const [alertName, setAlertName] = useState("Slow & low-judge trace");
  const [alertSeverity, setAlertSeverity] = useState<"low" | "medium" | "high" | "critical">("high");
  const [compileResult, setCompileResult] = useState<{
    alert_id: string;
    name: string;
    sql: string;
    severity: string;
  } | null>(null);
  const [compiling, setCompiling] = useState(false);

  // Existing alerts
  const [alerts, setAlerts] = useState<AlertSummary[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const loadAlerts = useCallback(async () => {
    if (!currentOrg) return;
    setAlertsLoading(true);
    try {
      const res = await listAlerts(currentOrg.id);
      setAlerts(res.alerts);
    } catch (_e) {
      // silent — no toast, alerts are read-only
    } finally {
      setAlertsLoading(false);
    }
  }, [currentOrg]);
  useEffect(() => {
    if (currentOrg) loadAlerts();
  }, [currentOrg, loadAlerts]);
  function clearResults() {
    setParseResult(null);
    setLintWarnings([]);
    setResolveResult(null);
    setError("");
  }
  async function runParse() {
    if (!currentOrg) return;
    setActiveOp("parse");
    setError("");
    try {
      const res = await parseQuery(currentOrg.id, query);
      setParseResult(res);
    } catch (err) {
      setError(errorFromCaught(err, "Parse failed"));
      setParseResult(null);
    } finally {
      setActiveOp(null);
    }
  }
  async function runLint() {
    if (!currentOrg) return;
    setActiveOp("lint");
    setError("");
    try {
      const res = await lintQuery(currentOrg.id, query);
      setLintWarnings(res.warnings);
    } catch (err) {
      setError(errorFromCaught(err, "Lint failed"));
      setLintWarnings([]);
    } finally {
      setActiveOp(null);
    }
  }
  async function runResolve() {
    if (!currentOrg) return;
    setActiveOp("resolve");
    setError("");
    try {
      const res = await resolveQuery(currentOrg.id, query);
      setResolveResult(res);
    } catch (err) {
      setError(errorFromCaught(err, "Resolve failed"));
      setResolveResult(null);
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
      const res = await compileAlert(currentOrg.id, query, alertName, alertSeverity);
      setCompileResult(res);
      toast.success(`Alert compiled — ${res.alert_id.slice(0, 12)}…`);
      await loadAlerts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Compile failed");
    } finally {
      setCompiling(false);
    }
  }
  if (!currentOrg) {
    return <NoOrgState icon={Search} feature="Trace Query DSL" description="Parse, lint, and resolve Eden Query Language (EQL) expressions once your org is configured." />;
  }
  return <PageContent size="wide">
      <PageHeader title="Query" subtitle="Trace Query DSL with EQL syntax over the columnar engine" icon={Sparkles} eyebrow="Observe" />

      {error && <Alert variant="error" title="Request failed" description={error} onDismiss={() => setError("")} />}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left column: editor + results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Editor */}
          <Card padding="md" className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Code2 className="w-4 h-4 text-[var(--accent)]" />
              EQL Query
            </h3>
            <textarea value={query} onChange={e => {
            setQuery(e.target.value);
            clearResults();
          }} spellCheck={false} className="w-full min-h-[120px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]" placeholder="root.span.duration_ms > 1000 AND any.judge.score < 0.5" />
            <div className="flex flex-wrap gap-2">
              <button onClick={runParse} disabled={activeOp !== null} className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
                {activeOp === "parse" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Code2 className="w-3.5 h-3.5" />}
                Parse
              </button>
              <button onClick={runLint} disabled={activeOp !== null} className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
                {activeOp === "lint" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListChecks className="w-3.5 h-3.5" />}
                Lint
              </button>
              <button onClick={runResolve} disabled={activeOp !== null} className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
                {activeOp === "resolve" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Resolve
              </button>
            </div>
          </Card>

          {/* AST result */}
          {parseResult && <ResultCard title="AST" icon={Code2}>
              {parseResult.valid ? <p className="text-xs text-[var(--terminal)] flex items-center gap-1.5 mb-2">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Valid
                </p> : <p className="text-xs text-[var(--error)] flex items-center gap-1.5 mb-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> {parseResult.errors.length} error
                  {parseResult.errors.length === 1 ? "" : "s"}
                </p>}
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[300px]">
                {JSON.stringify(parseResult.ast, null, 2)}
              </pre>
            </ResultCard>}

          {/* Lint warnings */}
          {lintWarnings.length > 0 && <ResultCard title="Lint Warnings" icon={ListChecks}>
              <ul className="space-y-1.5">
                {lintWarnings.map((w, i) => <li key={i} className={cn("flex items-start gap-2 px-2.5 py-1.5 rounded-md text-xs", w.severity === "error" ? "bg-[var(--error-bg)] text-[var(--error)]" : w.severity === "warning" ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]")}>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-base)]/40">
                      L{w.line}:{w.column}
                    </span>
                    <span className="font-medium uppercase text-[10px] tracking-wide opacity-80">
                      {w.severity}
                    </span>
                    <span className="flex-1">{w.message}</span>
                  </li>)}
              </ul>
            </ResultCard>}

          {/* Resolve (SQL) result */}
          {resolveResult && <ResultCard title="Resolved SQL" icon={Sparkles}>
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto">
                {resolveResult.sql}
              </pre>
              {Object.keys(resolveResult.parameters).length > 0 && <>
                  <p className="text-[11px] font-medium text-[var(--text-muted)] mt-3 mb-1.5 uppercase tracking-wide">
                    Parameters
                  </p>
                  <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[180px]">
                    {JSON.stringify(resolveResult.parameters, null, 2)}
                  </pre>
                </>}
            </ResultCard>}

          {/* Compile alert */}
          <Card padding="md" className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--accent)]" />
              Compile Alert
            </h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
                  Name
                </label>
                <input type="text" value={alertName} onChange={e => setAlertName(e.target.value)} className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
                  Severity
                </label>
                <select value={alertSeverity} onChange={e => setAlertSeverity(e.target.value as typeof alertSeverity)} className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]">
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </div>
            </div>
            <button onClick={handleCompileAlert} disabled={compiling} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
              {compiling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
              Compile alert
            </button>

            {compileResult && <div className="mt-2 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs text-[var(--terminal)] flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Alert <span className="font-mono">{compileResult.alert_id}</span> compiled
                ({compileResult.severity})
              </div>}
          </Card>
        </div>

        {/* Right column: existing alerts */}
        <div className="space-y-4">
          <Card padding="lg" className="overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Bell className="w-4 h-4 text-[var(--accent)]" />
                Compiled Alerts
              </h3>
              <button onClick={loadAlerts} disabled={alertsLoading} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                {alertsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Refresh"}
              </button>
            </div>
            {alertsLoading && alerts.length === 0 ? <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
              </div> : alerts.length === 0 ? <div className="px-4 py-10 text-center">
                <Bell className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-40" />
                <p className="text-xs text-[var(--text-muted)]">No alerts yet</p>
              </div> : <div className="divide-y divide-[var(--border-subtle)]">
                {alerts.map(a => <div key={a.alert_id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {a.name}
                      </span>
                      <span className={cn("text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-medium flex-shrink-0", a.severity === "critical" ? "bg-[var(--error-bg)] text-[var(--error)]" : a.severity === "high" ? "bg-[var(--warning-bg)] text-[var(--warning)]" : a.severity === "medium" ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--accent-faint)] text-[var(--accent)]")}>
                        {a.severity}
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5 truncate">
                      {a.alert_id}
                    </p>
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                      {a.last_fired ? `Last fired ${new Date(a.last_fired).toLocaleString()}` : "Never fired"}
                    </p>
                  </div>)}
              </div>}
          </Card>
        </div>
      </div>
    </PageContent>;
}
function ResultCard({
  title,
  icon: Icon,
  children
}: {
  title: string;
  icon: React.ComponentType<{
    className?: string;
  }>;
  children: React.ReactNode;
}) {
  return <motion.div initial={{
    opacity: 0,
    y: 6
  }} animate={{
    opacity: 1,
    y: 0
  }} transition={{
    duration: 0.18
  }} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-[var(--accent)]" />
        {title}
      </h3>
      {children}
    </motion.div>;
}