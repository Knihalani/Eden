"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, ApiError, type AgentStumble } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  Download,
  FlaskConical,
  Loader2,
  ShieldAlert,
  Stethoscope,
  CheckCircle2,
  Ban,
  Wrench,
  Bug,
  Database,
  Copy,
} from "lucide-react";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RegressionBadge, RepeatBadge, IssueSeverityBadge, StatusBadge } from "../_components/issue-badges";

type Tab = "overview" | "triage" | "handoff" | "experiment";

export default function IssueDetailPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const issueId = params?.id;
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const qTab = searchParams?.get("tab");
    if (qTab === "handoff" || searchParams?.get("handoff") === "coding-agent") {
      setTab("handoff");
    }
  }, [searchParams]);

  const issueQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId!),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const issue = issueQuery.data?.data?.issue ?? null;
  const loading = issueQuery.isLoading;
  const error = issueQuery.error?.message ?? null;
  const isNotFound =
    issueQuery.error instanceof ApiError && issueQuery.error.status === 404;

  // Fail closed: 5xx must surface as ErrorState, not a false-empty panel.
  const stumblesQuery = useOrgQuery(
    queryKeys.issues.stumbles(orgId, { fingerprint: issue?.fingerprint, limit: 20 }),
    orgId,
    () =>
      agentIssuesApi
        .stumbles(orgId!, { fingerprint: issue!.fingerprint, limit: 20 })
        .then((res) => res.data?.stumbles ?? []),
    { enabled: Boolean(orgId) && Boolean(issue?.fingerprint) },
  );
  const stumbles = stumblesQuery.data ?? [];
  const stumblesError = stumblesQuery.error?.message ?? null;

  const experimentsQuery = useOrgQuery(
    queryKeys.issues.experiments(orgId, issueId),
    orgId,
    () =>
      agentIssuesApi
        .listExperiments(orgId!, issueId!)
        .then((res) => res.data?.experiments ?? []),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const experiments = experimentsQuery.data ?? [];
  const experimentsError = experimentsQuery.error?.message ?? null;

  const regressionQuery = useOrgQuery(
    queryKeys.issues.regressionCases(orgId, issueId),
    orgId,
    () =>
      agentIssuesApi
        .listRegressionCases(orgId!, issueId!)
        .then((res) => (res.data?.cases as Record<string, unknown>[]) ?? []),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const regressionCases = regressionQuery.data ?? [];
  const regressionError = regressionQuery.error?.message ?? null;

  const invalidateIssue = [
    queryKeys.issues.detail(orgId, issueId),
    queryKeys.issues.list(orgId),
    queryKeys.issues.experiments(orgId, issueId),
    queryKeys.issues.regressionCases(orgId, issueId),
  ];

  const triageMutation = useOrgMutation(
    () => agentIssuesApi.triage(orgId!, issueId!, { force: true }),
    { invalidateKeys: invalidateIssue },
  );
  const resolveMutation = useOrgMutation(
    (status: "resolved" | "ignored") => agentIssuesApi.resolve(orgId!, issueId!, { status }),
    { invalidateKeys: invalidateIssue },
  );
  const createExperimentMutation = useOrgMutation(
    () =>
      agentIssuesApi.createExperiment(orgId!, issueId!, {
        control_variant: "production",
        treatment_variant: "candidate",
      }),
    { invalidateKeys: invalidateIssue },
  );

  const onTriage = async () => {
    if (!orgId || !issueId) return;
    setBusy("triage");
    try {
      await triageMutation.mutateAsync();
      toast.success("Triage complete");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Triage failed");
    } finally {
      setBusy(null);
    }
  };

  const onResolve = async (status: "resolved" | "ignored") => {
    if (!orgId || !issueId) return;
    setBusy(status);
    try {
      await resolveMutation.mutateAsync(status);
      toast.success(`Issue ${status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const onExportFixture = async () => {
    if (!orgId || !issueId) return;
    setBusy("export");
    try {
      const res = await agentIssuesApi.exportFixture(orgId, issueId);
      const fixture = res.data?.fixture ?? res.data;
      const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eden-fixture-${issueId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Fixture exported");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  };

  const onSaveRegression = async () => {
    if (!orgId || !issueId) return;
    setBusy("regression");
    try {
      await agentIssuesApi.createRegressionCases(orgId, issueId, { auto: true });
      toast.success("Regression case saved to permanent memory");
      void issueQuery.refetch();
      void regressionQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Regression save failed");
    } finally {
      setBusy(null);
    }
  };

  const onCreateExperiment = async () => {
    if (!orgId || !issueId) return;
    setBusy("experiment");
    try {
      await createExperimentMutation.mutateAsync();
      toast.success("Experiment started");
      setTab("experiment");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Experiment failed");
    } finally {
      setBusy(null);
    }
  };

  const onExperimentReport = async (linkId: string) => {
    if (!orgId || !issueId) return;
    setBusy(`report-${linkId}`);
    try {
      const res = await agentIssuesApi.experimentReport(orgId, issueId, linkId);
      toast.success(
        `Report: ${String((res.data?.report as Record<string, unknown>)?.recommendation ?? "ready")}`,
      );
      void experimentsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Report failed");
    } finally {
      setBusy(null);
    }
  };

  if (!currentOrg) {
    return <NoOrgState feature="Agent Issues" icon={ShieldAlert} description="Select an organization" />;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "triage", label: "Triage" },
    { id: "handoff", label: "Handoff" },
    { id: "experiment", label: "Experiment" },
  ];

  return (
    <PageContent size="default">
      <Link href="/issues" className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-4">
        <ArrowLeft className="h-4 w-4" /> Back to issues
      </Link>

      {loading ? (
        <div role="status" aria-busy="true" className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
        </div>
      ) : isNotFound || (!issue && !error) ? (
        <Card padding="lg"><p className="text-sm text-[var(--text-muted)]">Issue not found.</p></Card>
      ) : error || !issue ? (
        <ErrorState
          title="Could not load issue"
          message={error ?? "Could not load issue."}
          action={
            <Button variant="outline" size="sm" onClick={() => void issueQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <IssueSeverityBadge severity={issue.severity} />
              <StatusBadge status={issue.status} />
              <RegressionBadge regressionCaseId={issue.regression_case_id} status={issue.status} />
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{issue.kind}</span>
              {issue.repetition_count > 1 && <RepeatBadge count={issue.repetition_count} />}
            </div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{issue.title}</h1>
            <p className="mt-1 text-xs text-[var(--text-muted)] font-mono break-all">fingerprint: {issue.fingerprint}</p>

            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as Tab)}
              className="mt-space-4"
            >
              <TabsList
                variant="underline"
                aria-label="Issue sections"
                className="h-auto w-full justify-start gap-space-1 bg-transparent"
              >
                {tabs.map((t) => (
                  <TabsTrigger
                    key={t.id}
                    variant="underline"
                    value={t.id}
                    className="min-h-11"
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="mt-space-4 flex flex-wrap gap-space-2">
              <Button size="sm" variant="default" className="min-h-11" disabled={busy !== null} onClick={onTriage}>
                {busy === "triage" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Stethoscope className="h-3 w-3 mr-1" />}
                Re-triage
              </Button>
              <Button size="sm" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={onExportFixture}>
                <Download className="h-3 w-3 mr-1" /> Export fixture
              </Button>
              <Button size="sm" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => void onSaveRegression()}>
                <Database className="h-3 w-3 mr-1" /> Save regression
              </Button>
              <Button size="sm" variant="outline" className="min-h-11" asChild>
                <Link href={`/improve?issue=${issueId}`}>
                  <Bug className="h-3 w-3 mr-1" /> View improvement plan
                </Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11"
                onClick={() => setTab("handoff")}
              >
                <Wrench className="h-3 w-3 mr-1" /> Open in coding agent
              </Button>
              <Button size="sm" variant="secondary" className="min-h-11" disabled={busy !== null || issue.status === "resolved"} onClick={() => onResolve("resolved")}>
                <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
              </Button>
              <Button size="sm" variant="outline" className="min-h-11" disabled={busy !== null || issue.status === "ignored"} onClick={() => onResolve("ignored")}>
                <Ban className="h-3 w-3 mr-1" /> Ignore
              </Button>
            </div>
          </div>

          {tab === "overview" && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <Stat label="Stumbles" value={issue.stumble_count} />
                <Stat label="Users" value={issue.user_count} />
                <Stat label="Repeats" value={issue.repetition_count} />
                <Stat label="Agent" value={issue.agent_id ?? "—"} />
              </div>
              <RegressionMemoryPanel
                cases={regressionCases}
                caseId={issue.regression_case_id}
                onSave={() => void onSaveRegression()}
                busy={busy === "regression"}
                error={regressionError}
                onRetry={() => void regressionQuery.refetch()}
              />
              {issue.triage_result && Object.keys(issue.triage_result).length > 0 && (
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
                  <h2 className="text-sm font-semibold mb-2">Triage result</h2>
                  <pre className="p-2 rounded bg-[var(--bg-tertiary)] text-xs font-mono overflow-x-auto">
                    {JSON.stringify(issue.triage_result, null, 2)}
                  </pre>
                </div>
              )}
              <StumblesList
                stumbles={stumbles}
                error={stumblesError}
                onRetry={() => void stumblesQuery.refetch()}
              />
            </>
          )}

          {tab === "triage" && (
            <TriagePanel
              triageResult={issue.triage_result}
              stumbles={stumbles}
              stumblesError={stumblesError}
              onStumblesRetry={() => void stumblesQuery.refetch()}
            />
          )}

          {tab === "handoff" && (
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 space-y-4">
              <p className="text-sm text-[var(--text-secondary)]">
                Ship a fix via the Improve queue, coding-agent handoff, or fixture export.
                Copy the handoff prompt below into your coding agent.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="min-h-11" asChild>
                  <Link href={`/improve?issue=${issueId}`}>View improvement plan</Link>
                </Button>
                <Button size="sm" variant="outline" className="min-h-11" disabled={busy !== null} onClick={onExportFixture}>
                  <Download className="h-3 w-3 mr-1" /> Export fixture
                </Button>
              </div>
              <CodingAgentHandoff
                orgId={orgId!}
                issueId={issueId!}
                fingerprint={issue.fingerprint}
                title={issue.title}
                kind={issue.kind}
                onCopy={() => toast.success("Handoff prompt copied")}
              />
            </div>
          )}

          {tab === "experiment" && (
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <FlaskConical className="h-4 w-4" /> Issue-linked experiments (F33)
                </h2>
                <Button size="sm" disabled={busy !== null} onClick={onCreateExperiment}>
                  Run A/B wizard
                </Button>
              </div>
              {issue.experiment_result && (
                <ExperimentReportBanner report={issue.experiment_result as Record<string, unknown>} />
              )}
              {experimentsError ? (
                <ErrorState
                  size="sm"
                  title="Experiments unavailable"
                  message={experimentsError}
                  action={
                    <Button variant="outline" size="sm" onClick={() => void experimentsQuery.refetch()}>
                      Try again
                    </Button>
                  }
                />
              ) : experiments.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">No experiments yet. Start one to measure if a fix reduced stumble rate.</p>
              ) : (
                <ul className="space-y-2">
                  {experiments.map((e) => (
                    <li key={String(e.id)} className="rounded border border-[var(--border-subtle)] p-2 flex items-center justify-between gap-2">
                      <span className="text-xs font-mono">{String(e.experiment_id)}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => onExperimentReport(String(e.id))}
                      >
                        View report
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </PageContent>
  );
}

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
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className={`text-sm font-semibold ${recColor}`}>
        {rec.replace(/_/g, " ")}
      </div>
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

function TriagePanel({
  triageResult,
  stumbles,
  stumblesError,
  onStumblesRetry,
}: {
  triageResult?: Record<string, unknown> | null;
  stumbles: AgentStumble[];
  stumblesError?: string | null;
  onStumblesRetry?: () => void;
}) {
  const tr = (triageResult ?? {}) as Record<string, unknown>;
  const hasTriage = Object.keys(tr).length > 0;
  const evidenceSpans = Array.isArray(tr.evidence_span_ids)
    ? (tr.evidence_span_ids as unknown[]).map(String)
    : [];
  const suggestedActions = Array.isArray(tr.suggested_actions)
    ? (tr.suggested_actions as Record<string, unknown>[])
    : [];
  const linkedFiles = Array.isArray(tr.linked_files)
    ? (tr.linked_files as unknown[]).map(String)
    : [];
  const debuggerTraceId =
    typeof tr.debugger_trace_id === "string"
      ? tr.debugger_trace_id
      : stumbles.find((s) => s.trace_id)?.trace_id ?? null;
  // Map a span id → the trace it was seen in (for deep links).
  const spanToTrace = new Map<string, string>();
  for (const s of stumbles) {
    if (s.span_id && s.trace_id) spanToTrace.set(String(s.span_id), String(s.trace_id));
  }

  if (!hasTriage) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <p className="text-sm text-[var(--text-muted)]">
            No triage result yet. Run “Re-triage” to investigate the root cause.
          </p>
        </div>
        {stumblesError ? (
          <ErrorState
            size="sm"
            title="Stumbles unavailable"
            message={stumblesError}
            action={
              onStumblesRetry ? (
                <Button variant="outline" size="sm" onClick={onStumblesRetry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stumblesError ? (
        <ErrorState
          size="sm"
          title="Stumbles unavailable"
          message={stumblesError}
          action={
            onStumblesRetry ? (
              <Button variant="outline" size="sm" onClick={onStumblesRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold">Root cause</h2>
          {tr.source ? (
            <span className="text-2xs uppercase tracking-wide px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {String(tr.source)}
            </span>
          ) : null}
          {typeof tr.confidence === "number" ? (
            <span className="text-2xs text-[var(--text-muted)]">
              confidence {(Number(tr.confidence) * 100).toFixed(0)}%
            </span>
          ) : null}
          {tr.auto_escalate ? (
            <span className="text-2xs uppercase px-2 py-0.5 rounded bg-[var(--error-bg)] text-[var(--error)]">
              auto-escalate
            </span>
          ) : null}
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          {String(tr.root_cause ?? "—")}
        </p>
        {debuggerTraceId ? (
          <Button size="sm" variant="secondary" asChild className="mt-2">
            <Link
              href={`/traces?view=debug&trace_id=${encodeURIComponent(debuggerTraceId)}`}
            >
              <Bug className="h-3 w-3 mr-1" /> Open debugger
            </Link>
          </Button>
        ) : null}
      </div>

      {suggestedActions.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="text-sm font-semibold mb-2">Suggested actions</h2>
          <ul className="space-y-2">
            {suggestedActions.map((a, i) => {
              const actionType = String(a.type ?? a.action_type ?? "action");
              const traceForDebugger =
                typeof a.trace_id === "string"
                  ? a.trace_id
                  : debuggerTraceId;
              return (
              <li
                key={i}
                className="rounded border border-[var(--border-subtle)] p-2 flex items-center gap-2 flex-wrap"
              >
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--accent)]">
                  {actionType}
                </span>
                <span className="text-sm text-[var(--text-secondary)]">
                  {String(a.summary ?? "")}
                </span>
                {actionType === "debugger_rerun" && traceForDebugger ? (
                  <Link
                    href={`/traces?view=debug&trace_id=${encodeURIComponent(traceForDebugger)}`}
                    className="text-xs text-[var(--accent)] hover:underline"
                  >
                    Open debugger
                  </Link>
                ) : null}
              </li>
            );
            })}
          </ul>
        </div>
      )}

      {evidenceSpans.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="text-sm font-semibold mb-2">Evidence spans</h2>
          <ul className="flex flex-wrap gap-2">
            {evidenceSpans.map((span) => {
              const traceId = spanToTrace.get(span);
              return traceId ? (
                <li key={span}>
                  <Link
                    href={`/traces/${traceId}?span=${span}`}
                    className="text-xs font-mono text-[var(--accent)] hover:underline"
                  >
                    {span}
                  </Link>
                </li>
              ) : (
                <li key={span} className="text-xs font-mono text-[var(--text-muted)]">
                  {span}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {linkedFiles.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="text-sm font-semibold mb-2">Linked files</h2>
          <ul className="space-y-1">
            {linkedFiles.map((f) => (
              <li key={f} className="text-xs font-mono text-[var(--text-secondary)]">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StumblesList({
  stumbles,
  error,
  onRetry,
}: {
  stumbles: AgentStumble[];
  error?: string | null;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <ErrorState
        size="sm"
        title="Stumbles unavailable"
        message={error}
        action={
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <h2 className="text-sm font-semibold mb-3">Recent stumbles ({stumbles.length})</h2>
      {stumbles.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No stumbles recorded.</p>
      ) : (
        <ul className="space-y-2">
          {stumbles.map((s) => (
            <li key={s.id} className="rounded border border-[var(--border-subtle)] p-2">
              <div className="flex items-center gap-2 flex-wrap">
                <IssueSeverityBadge severity={s.severity} />
                <span className="text-xs text-[var(--text-muted)]">{s.detected_by}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{s.title}</p>
              {s.trace_id && (
                <Link href={`/traces/${s.trace_id}`} className="text-xs font-mono text-[var(--accent)] hover:underline break-all">
                  {s.trace_id}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-[var(--border-subtle)] p-2">
      <p className="text-2xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="text-sm font-semibold text-[var(--text-primary)] mt-0.5 truncate">{value}</p>
    </div>
  );
}

function RegressionMemoryPanel({
  cases,
  caseId,
  onSave,
  busy,
  error,
  onRetry,
}: {
  cases: Record<string, unknown>[];
  caseId?: string | null;
  onSave: () => void;
  busy: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <ErrorState
        size="sm"
        title="Regression memory unavailable"
        message={error}
        action={
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Database className="h-4 w-4" /> Regression memory (D7)
        </h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={onSave}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Pin case"}
        </Button>
      </div>
      {caseId ? (
        <p className="text-xs font-mono text-[var(--text-muted)] mb-2">
          Linked case: {caseId}
        </p>
      ) : (
        <p className="text-xs text-[var(--text-muted)] mb-2">
          No permanent regression case yet — pin one before resolve to gate future canaries.
        </p>
      )}
      {cases.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No cases materialized for this issue.</p>
      ) : (
        <ul className="space-y-1 text-xs font-mono">
          {cases.map((c) => (
            <li key={String(c.id)} className="text-[var(--text-secondary)]">
              {String(c.id)} · trace {String(c.source_trace_id ?? "—")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CodingAgentHandoff({
  orgId,
  issueId,
  fingerprint,
  title,
  kind,
  onCopy,
}: {
  orgId: string;
  issueId: string;
  fingerprint: string;
  title: string;
  kind: string;
  onCopy: () => void;
}) {
  const prompt = [
    `# Eden issue handoff`,
    `org: ${orgId}`,
    `issue_id: ${issueId}`,
    `fingerprint: ${fingerprint}`,
    `kind: ${kind}`,
    `title: ${title}`,
    ``,
    `Fix this production agent failure. Export the Eden fixture from the issue`,
    `page, reproduce locally, open a PR. Prefer Eden Improve plan approve`,
    `when an N20 improvement_plan already exists for this fingerprint.`,
  ].join("\n");

  return (
    <div
      data-testid="coding-agent-handoff"
      className="rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Wrench className="h-4 w-4" /> Open in coding agent
        </h3>
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11"
          onClick={() => {
            void navigator.clipboard.writeText(prompt).then(onCopy);
          }}
        >
          <Copy className="h-3 w-3 mr-1" /> Copy prompt
        </Button>
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap text-[var(--text-secondary)] overflow-x-auto">
        {prompt}
      </pre>
    </div>
  );
}
