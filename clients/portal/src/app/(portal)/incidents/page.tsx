"use client";

import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { rcaApi } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  AlertOctagon,
  ChevronRight,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useToast } from "@/components/ui/toast";

interface Incident {
  cluster_id: string;
  severity: string;
  member_count: number;
  first_seen: string;
  last_seen: string;
  top_failure_mode?: string;
  top_failure_count?: number;
}

export default function IncidentsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();

  const incidentsQuery = useOrgQuery(
    queryKeys.incidents.list(orgId),
    orgId,
    () => rcaApi.listIncidents(orgId!),
  );
  const incidents = (incidentsQuery.data?.incidents as unknown as Incident[]) ?? [];
  const loading = incidentsQuery.isLoading;
  const error = incidentsQuery.error?.message ?? "";

  const clusterMutation = useOrgMutation(
    () => rcaApi.clusterIncidents(orgId!),
    { invalidateKeys: [queryKeys.incidents.list(orgId)] },
  );
  const clustering = clusterMutation.isPending;

  async function handleCluster() {
    if (!orgId) return;
    try {
      const data = await clusterMutation.mutateAsync();
      toast.success(
        `Clustering complete — ${data.cluster_count} cluster${data.cluster_count === 1 ? "" : "s"}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clustering failed");
    }
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={AlertOctagon}
        feature="Incidents"
        description="Cluster-level RCA summaries and recurring-failure detection appear once your organization is configured."
      />
    );
  }

  const columns: DataTableColumn<Incident>[] = [
    {
      key: "cluster_id",
      header: "Cluster ID",
      sortable: true,
      cell: (inc) => (
        <span className="font-mono text-xs text-[var(--text-primary)]">
          {inc.cluster_id.length > 20 ? `${inc.cluster_id.slice(0, 20)}…` : inc.cluster_id}
        </span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      sortable: true,
      cell: (inc) => <SeverityBadge severity={inc.severity} />,
    },
    {
      key: "member_count",
      header: "Members",
      sortable: true,
      align: "right",
      cell: (inc) => <span className="text-[var(--text-secondary)]">{inc.member_count}</span>,
    },
    {
      key: "first_seen",
      header: "First seen",
      sortable: true,
      cell: (inc) => <span className="text-[var(--text-muted)] text-xs">{formatTime(inc.first_seen)}</span>,
    },
    {
      key: "last_seen",
      header: "Last seen",
      sortable: true,
      cell: (inc) => <span className="text-[var(--text-muted)] text-xs">{formatTime(inc.last_seen)}</span>,
    },
    {
      key: "top_failure_mode",
      header: "Top failure mode",
      cell: (inc) => (
        <span className="text-[var(--text-secondary)] text-xs max-w-xs truncate block">
          {inc.top_failure_mode ?? "—"}
        </span>
      ),
    },
    {
      key: "cluster_id_link",
      header: "",
      align: "right",
      cell: (inc) => (
        <Link
          href={`/incidents/${inc.cluster_id}`}
          className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
          Inspect
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      ),
    },
  ];

  return (
    <PageContent size="wide">
      <PageHeader
        title="Incidents"
        subtitle={
          <>
            Systemic RCA clusters — recurring failure patterns across many traces. For individual
            grouped agent failures, see{" "}
            <Link href="/issues" className="text-[var(--accent)] hover:underline">
              Agent Issues
            </Link>
            .
          </>
        }
        icon={AlertOctagon}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => incidentsQuery.refetch()}
              disabled={loading}
              aria-label="Refresh incidents"
              className="inline-flex min-h-11 items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={handleCluster}
              disabled={clustering}
              aria-label="Run clustering now"
              className="inline-flex min-h-11 items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {clustering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Run clustering
            </button>
          </div>
        }
      />

      {error ? (
        <ErrorState
          title="Could not load incidents"
          message={error}
          action={
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => void incidentsQuery.refetch()}
              disabled={loading}
            >
              Try again
            </Button>
          }
        />
      ) : (
      /* Incidents table */
      <DataTable
        columns={columns}
        rows={incidents}
        rowKey={(inc) => inc.cluster_id}
        loading={loading && incidents.length === 0}
        defaultSort={{ key: "last_seen", direction: "desc" }}
        emptyTitle="No incidents yet"
        emptyDescription="Run clustering to detect systemic failure patterns across many traces."
        emptyIcon={AlertOctagon}
        emptyAction={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={handleCluster}
              disabled={clustering}
              className="inline-flex min-h-11 items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {clustering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Run clustering
            </button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/issues">View Agent Issues</Link>
            </Button>
          </div>
        }
        pageSize={25}
      />
      )}
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
