"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { api, rcaApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { AlertOctagon, AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Loader2, Network } from "lucide-react";
import { Card } from "@/components/ui/card";

const detailRcaApi = {
  summarizeIncident: (orgId: string, clusterId: string) => api.get<{
    cluster_id: string;
    summary: string;
    member_count: number;
    severity: string;
    first_seen: string;
    last_seen: string;
  }>(`/orgs/${orgId}/intelligence/rca/incidents/${clusterId}/summarize`),
  listIncidents: (orgId: string) => api.get<{
    incidents: Array<Record<string, unknown>>;
  }>(`/orgs/${orgId}/intelligence/rca/incidents`)
};
interface FactorItem {
  factor: string;
  weight: number;
  description?: string;
}
interface MemberTrace {
  trace_id: string;
  occurred_at: string;
  outcome: string;
  top_event?: string;
}
export default function IncidentDetailPage() {
  const {
    cluster_id
  } = useParams<{
    cluster_id: string;
  }>();
  const router = useRouter();
  const toast = useToast();
  const {
    currentOrg
  } = useOrg();
  const orgId = currentOrg?.id;
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(false);

  // Two independent GETs on mount — summarize gives the headline
  // stats, list gives factors/members for this cluster (not returned
  // by summarize). Both are React Query-backed so they fetch in
  // parallel and share a single retry.
  const summaryQuery = useOrgQuery(
    queryKeys.incidents.summary(orgId, cluster_id),
    orgId,
    () => detailRcaApi.summarizeIncident(orgId!, cluster_id),
    { enabled: Boolean(orgId) && Boolean(cluster_id) },
  );
  const listQuery = useOrgQuery(
    queryKeys.incidents.list(orgId),
    orgId,
    () => detailRcaApi.listIncidents(orgId!),
  );

  const summary = summaryQuery.data ?? null;
  const matched = (listQuery.data?.incidents as unknown as Array<Record<string, unknown>> | undefined)?.find(
    (i) => i.cluster_id === cluster_id,
  );
  const factors = (matched?.factors as FactorItem[] | undefined) ?? [];
  const members = ((matched?.recent_members as MemberTrace[] | undefined) ?? []).slice(0, 5);
  const alreadyResolved =
    resolved ||
    matched?.status === "resolved" ||
    (typeof matched?.status === "string" && matched.status === "resolved");

  const loading = summaryQuery.isLoading || listQuery.isLoading;
  const error = summaryQuery.error?.message ?? listQuery.error?.message ?? "";
  const retry = () => {
    summaryQuery.refetch();
    listQuery.refetch();
  };

  async function handleResolve() {
    if (!orgId || !cluster_id || resolving || alreadyResolved) return;
    setResolving(true);
    try {
      await rcaApi.resolveIncident(orgId, cluster_id);
      setResolved(true);
      toast.success("Incident marked resolved");
      await listQuery.refetch();
      // Soft redirect back to the list after a beat so the toast is readable.
      window.setTimeout(() => router.push("/incidents"), 800);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resolve incident");
    } finally {
      setResolving(false);
    }
  }

  if (!currentOrg) {
    return <NoOrgState icon={AlertOctagon} feature="Incident Detail" description="Cluster-level RCA detail will appear once your organization is configured." />;
  }
  return <PageContent size="default">
      <div>
        <Link href="/incidents" className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to incidents
        </Link>
      </div>

      <PageHeader
        eyebrow="Observe"
        title="Incident cluster"
        subtitle="Root-cause summary, contributing factors, and the traces that make up this cluster."
        icon={AlertOctagon}
        actions={
          <button
            type="button"
            onClick={() => void handleResolve()}
            disabled={resolving || alreadyResolved}
            aria-label={alreadyResolved ? "Incident resolved" : "Mark resolved"}
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              alreadyResolved
                ? "bg-[var(--terminal-faint)] text-[var(--terminal)] cursor-default"
                : "bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50",
            )}
          >
            {resolving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            {alreadyResolved ? "Resolved" : resolving ? "Resolving…" : "Mark resolved"}
          </button>
        }
      />
      <p className="text-xs font-mono text-[var(--text-muted)] -mt-4 mb-6 break-all">
        {cluster_id}
      </p>

      {error && <div role="alert" className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center justify-between gap-2.5 border border-[var(--error)]/20">
          <span className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {error}
          </span>
          <button onClick={retry} disabled={loading} className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50">
            Retry
          </button>
        </div>}

      {loading && !summary ? <div role="status" aria-live="polite" aria-busy="true" className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : summary ? <>
          {/* Summary card */}
          <Card padding="lg" className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <SeverityBadge severity={summary.severity} />
              {alreadyResolved && (
                <span className="text-xs font-medium text-[var(--terminal)]">Resolved</span>
              )}
              <span className="text-xs text-[var(--text-muted)]">
                {summary.member_count} member trace{summary.member_count === 1 ? "" : "s"}
              </span>
              <span className="text-xs text-[var(--text-muted)]">·</span>
              <span className="text-xs text-[var(--text-muted)]">
                First seen {formatTime(summary.first_seen)}
              </span>
              <span className="text-xs text-[var(--text-muted)]">·</span>
              <span className="text-xs text-[var(--text-muted)]">
                Last seen {formatTime(summary.last_seen)}
              </span>
            </div>
            <p className="text-base text-[var(--text-primary)] leading-relaxed">
              {summary.summary}
            </p>
          </Card>

          {/* Factors */}
          <Card padding="lg">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Network className="w-4 h-4 text-[var(--accent)]" />
              Suggested root cause factors
            </h3>
            {factors.length === 0 ? <p className="text-xs text-[var(--text-muted)]">
                No factors surfaced for this cluster.
              </p> : <ul className="space-y-2">
                {factors.map((f, idx) => <li key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-secondary)]">
                    <span className="text-xs text-[var(--text-muted)] font-mono w-6 text-right flex-shrink-0">
                      {idx + 1}.
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {f.factor}
                      </p>
                      {f.description && <p className="text-xs text-[var(--text-muted)] mt-0.5">
                          {f.description}
                        </p>}
                    </div>
                    <span className="text-xs text-[var(--text-muted)] flex-shrink-0">
                      weight {f.weight?.toFixed?.(2) ?? f.weight}
                    </span>
                  </li>)}
              </ul>}
          </Card>

          {/* Member traces */}
          <Card padding="lg">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Recent member traces
            </h3>
            {members.length === 0 ? <p className="text-xs text-[var(--text-muted)]">
                No member traces available for this cluster.
              </p> : <ul className="divide-y divide-[var(--border-subtle)]">
                {members.map(m => <li key={m.trace_id} className="flex items-center gap-3 py-2.5">
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", m.outcome === "failure" || m.outcome === "error" ? "bg-[var(--error)]" : m.outcome === "partial" ? "bg-[var(--warning)]" : "bg-[var(--terminal)]")} />
                    <span className="font-mono text-xs text-[var(--text-primary)] flex-1 truncate">
                      {m.trace_id}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {formatTime(m.occurred_at)}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  </li>)}
              </ul>}
          </Card>
        </> : null}
    </PageContent>;
}
function formatTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}
