"use client";

import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { rcaApi } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  AlertOctagon,
  ChevronRight,
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
  const embedded = useEmbeddedSurface();

  const incidentsQuery = useOrgQuery(
    queryKeys.incidents.list(orgId),
    orgId,
    () => rcaApi.listIncidents(orgId!),
  );
  const incidents = (incidentsQuery.data?.incidents as unknown as Incident[]) ?? [];
  const loading = incidentsQuery.isLoading;

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
        <Button asChild variant="link" size="sm" className="min-h-11 px-0">
          <Link href={`/incidents/${inc.cluster_id}`}>
            Inspect
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </Button>
      ),
    },
  ];

  return (
    <PageContent size="wide">
      {!embedded ? (
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
            <div className="flex items-center gap-space-2">
              <Button
                onClick={() => void incidentsQuery.refetch()}
                disabled={loading}
                aria-label="Refresh incidents"
                variant="outline"
                className="min-h-11"
                loading={loading}
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </Button>
              <Button
                onClick={() => void handleCluster()}
                disabled={clustering}
                aria-label="Run clustering now"
                className="min-h-11"
                loading={clustering}
              >
                <Zap className="w-4 h-4" />
                Run clustering
              </Button>
            </div>
          }
        />
      ) : (
        <div className="mb-space-3 flex flex-wrap items-center justify-end gap-space-2">
          <Button
            onClick={() => void incidentsQuery.refetch()}
            disabled={loading}
            aria-label="Refresh incidents"
            variant="outline"
            className="min-h-11"
            loading={loading}
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
          <Button
            onClick={() => void handleCluster()}
            disabled={clustering}
            aria-label="Run clustering now"
            className="min-h-11"
            loading={clustering}
          >
            <Zap className="w-4 h-4" />
            Run clustering
          </Button>
        </div>
      )}

      {embedded ? null : (
        <p className="mb-space-3 text-sm text-[var(--text-muted)]">
          Prefer the Agent Issues hub Incidents tab — list entry redirects to{" "}
          <Link href="/issues?tab=incidents" className="text-[var(--accent)] hover:underline">
            /issues?tab=incidents
          </Link>
          .
        </p>
      )}

      <QueryState
        loading={loading && incidents.length === 0}
        error={incidentsQuery.error}
        data={incidentsQuery.data}
        onRetry={() => void incidentsQuery.refetch()}
        errorTitle="Could not load incidents"
        isEmpty={(d) => ((d?.incidents as unknown as Incident[] | undefined)?.length ?? 0) === 0}
        loadingSlot={<LoadingSkeleton variant="table" lines={5} className="p-0 max-w-none" />}
        emptySlot={
          <EmptyState
            icon={AlertOctagon}
            title="No incidents yet"
            description="Run clustering to detect systemic failure patterns across many traces."
            size="lg"
            action={
              <div className="flex flex-wrap items-center justify-center gap-space-2">
                <Button
                  onClick={() => void handleCluster()}
                  disabled={clustering}
                  loading={clustering}
                  className="min-h-11"
                >
                  <Zap className="w-4 h-4" />
                  Run clustering
                </Button>
                <Button asChild variant="outline" className="min-h-11">
                  <Link href="/issues">View Agent Issues</Link>
                </Button>
              </div>
            }
          />
        }
      >
        {() => (
          <DataTable
            columns={columns}
            rows={incidents}
            rowKey={(inc) => inc.cluster_id}
            loading={false}
            defaultSort={{ key: "last_seen", direction: "desc" }}
            emptyTitle="No incidents yet"
            emptyDescription="Run clustering to detect systemic failure patterns across many traces."
            emptyIcon={AlertOctagon}
            pageSize={25}
          />
        )}
      </QueryState>
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
