"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, type AgentIssue, type AgentStumble } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { ArrowLeft, Loader2, ShieldAlert, Stethoscope, CheckCircle2, Ban } from "lucide-react";
import { PageContent } from "@/components/layout/page-content";
import { SeverityBadge, StatusBadge, RepeatBadge } from "../page";

export default function IssueDetailPage() {
  const { currentOrg } = useOrg();
  const params = useParams<{ id: string }>();
  const issueId = params?.id;
  const toast = useToast();

  const [issue, setIssue] = useState<AgentIssue | null>(null);
  const [stumbles, setStumbles] = useState<AgentStumble[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  if (!currentOrg) {
    return <NoOrgState feature="Agent Issues" icon={ShieldAlert} description="Select an organization" />;
  }

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
        <Card padding="lg">
          <p className="text-sm text-[var(--error)]">{error}</p>
        </Card>
      ) : !issue ? (
        <Card padding="lg">
          <p className="text-sm text-[var(--text-muted)]">Issue not found.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <SeverityBadge severity={issue.severity} />
              <StatusBadge status={issue.status} />
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{issue.kind}</span>
              {issue.repetition_count > 1 && <RepeatBadge count={issue.repetition_count} />}
            </div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{issue.title}</h1>
            <p className="mt-1 text-xs text-[var(--text-muted)] font-mono break-all">fingerprint: {issue.fingerprint}</p>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Stat label="Stumbles" value={issue.stumble_count} />
              <Stat label="Users" value={issue.user_count} />
              <Stat label="Repeats" value={issue.repetition_count} />
              <Stat label="Agent" value={issue.agent_id ?? "—"} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="default" disabled={busy !== null} onClick={onTriage}>
                {busy === "triage" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Stethoscope className="h-3 w-3 mr-1" />}
                Re-triage
              </Button>
              <Button size="sm" variant="secondary" disabled={busy !== null || issue.status === "resolved"} onClick={() => onResolve("resolved")}>
                <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null || issue.status === "ignored"} onClick={() => onResolve("ignored")}>
                <Ban className="h-3 w-3 mr-1" /> Ignore
              </Button>
            </div>
          </div>

          {issue.triage_result && Object.keys(issue.triage_result).length > 0 && (
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Triage result</h2>
              <pre className="p-2 rounded bg-[var(--bg-tertiary)] text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto">
                {JSON.stringify(issue.triage_result, null, 2)}
              </pre>
            </div>
          )}

          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Recent stumbles ({stumbles.length})
            </h2>
            {stumbles.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No stumbles recorded.</p>
            ) : (
              <ul className="space-y-2">
                {stumbles.map((s) => (
                  <li key={s.id} className="rounded border border-[var(--border-subtle)] p-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <SeverityBadge severity={s.severity} />
                      <span className="text-xs text-[var(--text-muted)]">{s.detected_by}</span>
                      {s.detected_at && <span className="text-xs text-[var(--text-muted)]">{new Date(s.detected_at).toLocaleString()}</span>}
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
        </div>
      )}
    </PageContent>
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
