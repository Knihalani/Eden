"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { rcaApi } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Network,
} from "lucide-react";
import { Card } from "@/components/ui/card";

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
  const { cluster_id } = useParams<{ cluster_id: string }>();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [resolved, setResolved] = useState(false);

  const summaryQuery = useOrgQuery(
    queryKeys.incidents.summary(orgId, cluster_id),
    orgId,
    () => rcaApi.summarizeIncident(orgId!, cluster_id),
    { enabled: Boolean(orgId) && Boolean(cluster_id) },
  );
  const listQuery = useOrgQuery(
    queryKeys.incidents.list(orgId),
    orgId,
    () => rcaApi.listIncidents(orgId!),
  );

  const resolveMutation = useOrgMutation(
    (note?: string) => rcaApi.resolveIncident(orgId!, cluster_id, { note }),
    {
      invalidateKeys: [
        queryKeys.incidents.summary(orgId, cluster_id),
        queryKeys.incidents.list(orgId),
      ],
    },
  );

  const summary = summaryQuery.data ?? null;
  const isResolved =
    resolved || Boolean(summary?.summary?.includes("[Resolved]"));
  const matched = (listQuery.data?.incidents as unknown as Array<Record<string, unknown>> | undefined)?.find(
    (i) => i.cluster_id === cluster_id,
  );
  const factors = (matched?.factors as FactorItem[] | undefined) ?? [];
  const members = ((matched?.recent_members as MemberTrace[] | undefined) ?? []).slice(0, 5);

  const loading = summaryQuery.isLoading || listQuery.isLoading;
  const error = summaryQuery.error?.message ?? listQuery.error?.message ?? "";
  const retry = () => {
    summaryQuery.refetch();
    listQuery.refetch();
  };

  const handleResolve = async () => {
    if (!orgId || isResolved) return;
    const note = window.prompt("Resolution note (optional):") ?? "";
    try {
      await resolveMutation.mutateAsync(note.trim() || undefined);
      setResolved(true);
      toast.success("Incident marked resolved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resolve incident");
    }
  };

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={AlertOctagon}
        feature="Incident Detail"
        description="Cluster-level RCA detail will appear once your organization is configured."
      />
    );
  }

  return (
    <PageContent size="default">
      <div>
        <Link
          href="/issues?tab=incidents"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
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
          <Button
            onClick={() => void handleResolve()}
            disabled={isResolved || resolveMutation.isPending}
            loading={resolveMutation.isPending}
            aria-label={isResolved ? "Incident resolved" : "Mark incident resolved"}
            className={cn(
              isResolved &&
                "bg-[var(--terminal)]/10 text-[var(--terminal)] border border-[var(--terminal)]/30 hover:bg-[var(--terminal)]/10",
            )}
            variant={isResolved ? "outline" : "default"}
          >
            <CheckCircle2 className="w-4 h-4" />
            {isResolved ? "Resolved" : "Mark resolved"}
          </Button>
        }
      />
      <p className="text-xs font-mono text-[var(--text-muted)] -mt-4 mb-6 break-all">{cluster_id}</p>

      {error && (
        <div
          role="alert"
          className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center justify-between gap-2.5 border border-[var(--error)]/20"
        >
          <span className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {error}
          </span>
          <button
            onClick={retry}
            disabled={loading}
            className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {loading && !summary ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="flex items-center justify-center py-20"
        >
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : summary ? (
        <>
          <Card padding="lg" className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <SeverityBadge severity={summary.severity} />
              {isResolved && (
                <span className="text-xs font-medium text-[var(--terminal)] bg-[var(--terminal)]/10 px-2 py-0.5 rounded">
                  Resolved
                </span>
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
            <p className="text-base text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
              {summary.summary}
            </p>
          </Card>

          <Card padding="lg">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Network className="w-4 h-4 text-[var(--accent)]" />
              Suggested root cause factors
            </h3>
            {factors.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No factors surfaced for this cluster.</p>
            ) : (
              <ul className="space-y-2">
                {factors.map((f, idx) => (
                  <li key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-secondary)]">
                    <span className="text-xs text-[var(--text-muted)] font-mono w-6 text-right flex-shrink-0">
                      {idx + 1}.
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-[var(--text-primary)]">{f.factor}</p>
                      {f.description && (
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">{f.description}</p>
                      )}
                    </div>
                    <span className="text-xs text-[var(--text-muted)] flex-shrink-0">
                      weight {f.weight?.toFixed?.(2) ?? f.weight}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padding="lg">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Recent member traces</h3>
            {members.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No member traces available for this cluster.</p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {members.map((m) => (
                  <li key={m.trace_id} className="flex items-center gap-3 py-2.5">
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full flex-shrink-0",
                        m.outcome === "failure" || m.outcome === "error"
                          ? "bg-[var(--error)]"
                          : m.outcome === "partial"
                            ? "bg-[var(--warning)]"
                            : "bg-[var(--terminal)]",
                      )}
                    />
                    <span className="font-mono text-xs text-[var(--text-primary)] flex-1 truncate">
                      {m.trace_id}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">{formatTime(m.occurred_at)}</span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </PageContent>
  );
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
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
