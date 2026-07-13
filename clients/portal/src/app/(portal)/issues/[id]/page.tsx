"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, type AgentIssue, type AgentStumble } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  Download,
  FlaskConical,
  Loader2,
  MessageSquare,
  ShieldAlert,
  Stethoscope,
  CheckCircle2,
  Ban,
  Wrench,
} from "lucide-react";
import { PageContent } from "@/components/layout/page-content";
import { cn } from "@/lib/utils";
import { RegressionBadge, RepeatBadge, SeverityBadge, StatusBadge } from "../_components/issue-badges";

type Tab = "overview" | "fix" | "experiment";

export default function IssueDetailPage() {
  const { currentOrg } = useOrg();
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const issueId = params?.id;
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("overview");
  const [issue, setIssue] = useState<AgentIssue | null>(null);
  const [stumbles, setStumbles] = useState<AgentStumble[]>([]);
  const [experiments, setExperiments] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (pathname?.endsWith("/fix")) setTab("fix");
  }, [pathname]);

  const load = useCallback(async () => {
    if (!currentOrg || !issueId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await agentIssuesApi.get(currentOrg.id, issueId);
      const iss = res.data?.issue ?? null;
      setIssue(iss);
      if (iss?.fingerprint) {
        const st = await agentIssuesApi
          .stumbles(currentOrg.id, { fingerprint: iss.fingerprint, limit: 20 })
          .catch(() => ({ data: { stumbles: [], count: 0 } }));
        setStumbles(st.data?.stumbles ?? []);
      }
      const ex = await agentIssuesApi.listExperiments(currentOrg.id, issueId).catch(() => ({
        data: { experiments: [], count: 0 },
      }));
      setExperiments(ex.data?.experiments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load issue");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, issueId]);

  useEffect(() => {
    load();
  }, [load]);

  const onTriage = async () => {
    if (!currentOrg || !issueId) return;
    setBusy("triage");
    try {
      await agentIssuesApi.triage(currentOrg.id, issueId, { force: true });
      toast.success("Triage complete");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Triage failed");
    } finally {
      setBusy(null);
    }
  };

  const onResolve = async (status: "resolved" | "ignored") => {
    if (!currentOrg || !issueId) return;
    setBusy(status);
    try {
      await agentIssuesApi.resolve(currentOrg.id, issueId, { status });
      toast.success(`Issue ${status}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const onExportFixture = async () => {
    if (!currentOrg || !issueId) return;
    setBusy("export");
    try {
      const res = await agentIssuesApi.exportFixture(currentOrg.id, issueId);
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

  const onCreateExperiment = async () => {
    if (!currentOrg || !issueId) return;
    setBusy("experiment");
    try {
      await agentIssuesApi.createExperiment(currentOrg.id, issueId, {
        control_variant: "production",
        treatment_variant: "candidate",
      });
      toast.success("Experiment started");
      await load();
      setTab("experiment");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Experiment failed");
    } finally {
      setBusy(null);
    }
  };

  const onExperimentReport = async (linkId: string) => {
    if (!currentOrg || !issueId) return;
    setBusy(`report-${linkId}`);
    try {
      const res = await agentIssuesApi.experimentReport(currentOrg.id, issueId, linkId);
      toast.success(
        `Report: ${String((res.data?.report as Record<string, unknown>)?.recommendation ?? "ready")}`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Report failed");
    } finally {
      setBusy(null);
    }
  };

  if (!currentOrg) {
    return <NoOrgState feature="Agent Issues" icon={ShieldAlert} description="Select an organization" />;
  }

  const tabs: { id: Tab; label: string; href?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "fix", label: "Fix", href: `/issues/${issueId}/fix` },
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
      ) : error ? (
        <Card padding="lg"><p className="text-sm text-[var(--error)]">{error}</p></Card>
      ) : !issue ? (
        <Card padding="lg"><p className="text-sm text-[var(--text-muted)]">Issue not found.</p></Card>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <SeverityBadge severity={issue.severity} />
              <StatusBadge status={issue.status} />
              <RegressionBadge regressionCaseId={issue.regression_case_id} status={issue.status} />
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{issue.kind}</span>
              {issue.repetition_count > 1 && <RepeatBadge count={issue.repetition_count} />}
            </div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{issue.title}</h1>
            <p className="mt-1 text-xs text-[var(--text-muted)] font-mono break-all">fingerprint: {issue.fingerprint}</p>

            <div role="tablist" aria-label="Issue sections" className="flex gap-1 mt-4 border-b border-[var(--border-default)]">
              {tabs.map((t) =>
                t.href ? (
                  <Link
                    key={t.id}
                    role="tab"
                    href={t.href}
                    className={cn(
                      "px-3 py-2 text-sm font-medium border-b-2 -mb-px",
                      tab === t.id
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    )}
                  >
                    {t.label}
                  </Link>
                ) : (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "px-3 py-2 text-sm font-medium border-b-2 -mb-px",
                      tab === t.id
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    )}
                  >
                    {t.label}
                  </button>
                ),
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="default" disabled={busy !== null} onClick={onTriage}>
                {busy === "triage" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Stethoscope className="h-3 w-3 mr-1" />}
                Re-triage
              </Button>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={onExportFixture}>
                <Download className="h-3 w-3 mr-1" /> Export fixture
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href={`/issues/${issueId}/fix`}>
                  <MessageSquare className="h-3 w-3 mr-1" /> Fix in code
                </Link>
              </Button>
              <Button size="sm" variant="secondary" disabled={busy !== null || issue.status === "resolved"} onClick={() => onResolve("resolved")}>
                <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null || issue.status === "ignored"} onClick={() => onResolve("ignored")}>
                <Ban className="h-3 w-3 mr-1" /> Ignore
              </Button>
              <Link href={`/issues/${issueId}/fix`}>
                <Button size="sm" variant="secondary" className="min-h-[44px]">
                  <Wrench className="h-3 w-3 mr-1" /> Fix
                </Button>
              </Link>
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
              {issue.triage_result && Object.keys(issue.triage_result).length > 0 && (
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
                  <h2 className="text-sm font-semibold mb-2">Triage result</h2>
                  <pre className="p-2 rounded bg-[var(--bg-tertiary)] text-[11px] font-mono overflow-x-auto">
                    {JSON.stringify(issue.triage_result, null, 2)}
                  </pre>
                </div>
              )}
              <StumblesList stumbles={stumbles} />
            </>
          )}

          {tab === "fix" && (
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 space-y-3">
              <p className="text-sm text-[var(--text-secondary)]">
                Propose a fix via Improve queue or PR Suggestions. Eden links triage context to your repo.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild><Link href={`/improve?issue=${issueId}`}>Improve queue</Link></Button>
                <Button size="sm" variant="secondary" asChild><Link href="/pr-suggestions">PR Suggestions</Link></Button>
              </div>
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
                <pre className="p-2 rounded bg-[var(--bg-tertiary)] text-[11px] font-mono overflow-x-auto">
                  {JSON.stringify(issue.experiment_result, null, 2)}
                </pre>
              )}
              {experiments.length === 0 ? (
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

function StumblesList({ stumbles }: { stumbles: AgentStumble[] }) {
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
                <SeverityBadge severity={s.severity} />
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
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="text-sm font-semibold text-[var(--text-primary)] mt-0.5 truncate">{value}</p>
    </div>
  );
}
