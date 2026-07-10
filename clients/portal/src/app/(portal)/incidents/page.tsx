"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { rcaApi } from "@/lib/api";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  AlertOctagon,
  AlertTriangle,
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
  const toast = useToast();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [clustering, setClustering] = useState(false);

  const loadIncidents = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const data = await rcaApi.listIncidents(currentOrg.id);
      setIncidents((data.incidents as unknown as Incident[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load incidents");
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    if (currentOrg) loadIncidents();
  }, [currentOrg, loadIncidents]);

  async function handleCluster() {
    if (!currentOrg) return;
    setClustering(true);
    try {
      const data = await rcaApi.clusterIncidents(currentOrg.id);
      toast.success(
        `Clustering complete — ${data.cluster_count} cluster${data.cluster_count === 1 ? "" : "s"}`
      );
      await loadIncidents();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clustering failed");
    } finally {
      setClustering(false);
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
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
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
        subtitle="Cluster-level RCA summaries of recurring failures — catch the same bug biting 50 users before it bites 5,000"
        icon={AlertOctagon}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={loadIncidents}
              disabled={loading}
              aria-label="Refresh incidents"
              className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={handleCluster}
              disabled={clustering}
              aria-label="Run clustering now"
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {clustering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Run clustering
            </button>
          </div>
        }
      />

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
            onClick={loadIncidents}
            disabled={loading}
            className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {/* Incidents table */}
      <DataTable
        columns={columns}
        rows={incidents}
        rowKey={(inc) => inc.cluster_id}
        loading={loading && incidents.length === 0}
        defaultSort={{ key: "last_seen", direction: "desc" }}
        emptyTitle="No incidents yet"
        emptyDescription="Run clustering to detect recurring failures"
        emptyIcon={AlertOctagon}
        emptyAction={
          <button
            onClick={handleCluster}
            disabled={clustering}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {clustering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Run clustering
          </button>
        }
        pageSize={25}
      />
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
