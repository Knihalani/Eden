"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import {
  AlertOctagon,
  AlertTriangle,
  ChevronRight,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useToast } from "@/components/ui/toast";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function callApi<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const rcaApi = {
  listIncidents: (orgId: string) =>
    callApi<{ incidents: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/rca/incidents`),
  clusterIncidents: (orgId: string) =>
    callApi<{ clusters: Array<Record<string, unknown>>; cluster_count: number; }>(`/orgs/${orgId}/intelligence/rca/incidents/cluster`, { method: "POST" }),
};

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

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Incidents"
        subtitle="Cluster-level RCA summaries of recurring failures — catch the same bug biting 50 users before it bites 5,000"
        icon={AlertOctagon}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={loadIncidents}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button
              onClick={handleCluster}
              disabled={clustering}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {clustering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Run clustering
            </button>
          </div>
        }
      />

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Incidents table */}
      {loading && incidents.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : incidents.length === 0 ? (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <EmptyState
            icon={AlertOctagon}
            title="No incidents yet"
            description="Run clustering to detect recurring failures"
            size="lg"
            action={
              <button
                onClick={handleCluster}
                disabled={clustering}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
              >
                {clustering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Run clustering
              </button>
            }
          />
        </div>
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Cluster ID</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Severity</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Members</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">First seen</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Last seen</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Top failure mode</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {incidents.map((inc) => (
                  <tr
                    key={inc.cluster_id}
                    className="hover:bg-[var(--bg-tertiary)]/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">
                      {inc.cluster_id.length > 20
                        ? `${inc.cluster_id.slice(0, 20)}…`
                        : inc.cluster_id}
                    </td>
                    <td className="px-4 py-3">
                      <SeverityBadge severity={inc.severity} />
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {inc.member_count}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                      {formatTime(inc.first_seen)}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                      {formatTime(inc.last_seen)}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] text-xs max-w-xs truncate">
                      {inc.top_failure_mode ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/incidents/${inc.cluster_id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                      >
                        Inspect
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const sev = (severity || "unknown").toLowerCase();
  const classes: Record<string, string> = {
    high: "bg-[var(--error-bg)] text-[var(--error)]",
    critical: "bg-[var(--error-bg)] text-[var(--error)]",
    medium: "bg-[var(--warning-bg)] text-[var(--warning)]",
    low: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
    info: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  };
  return (
    <span
      className={cn(
        "text-xs px-2 py-0.5 rounded-full font-medium",
        classes[sev] || classes.info
      )}
    >
      {sev}
    </span>
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
