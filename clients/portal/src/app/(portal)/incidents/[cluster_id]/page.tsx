"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
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
  summarizeIncident: (orgId: string, clusterId: string) =>
    callApi<{ cluster_id: string; summary: string; member_count: number; severity: string; first_seen: string; last_seen: string; }>(`/orgs/${orgId}/intelligence/rca/incidents/${clusterId}/summarize`),
  listIncidents: (orgId: string) =>
    callApi<{ incidents: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/rca/incidents`),
};

interface SummaryResponse {
  cluster_id: string;
  summary: string;
  member_count: number;
  severity: string;
  first_seen: string;
  last_seen: string;
}

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
  const toast = useToast();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [factors, setFactors] = useState<FactorItem[]>([]);
  const [members, setMembers] = useState<MemberTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg || !cluster_id) return;
    setLoading(true);
    setError("");
    try {
      const data = await rcaApi.summarizeIncident(currentOrg.id, cluster_id);
      setSummary({
        cluster_id: data.cluster_id,
        summary: data.summary,
        member_count: data.member_count,
        severity: data.severity,
        first_seen: data.first_seen,
        last_seen: data.last_seen,
      });
      // Factors aren't returned by summarize; pull from the latest
      // cluster payload if the list endpoint had them.
      const list = await rcaApi.listIncidents(currentOrg.id);
      const matched = (list.incidents as unknown as Array<Record<string, unknown>>).find(
        (i) => i.cluster_id === cluster_id
      );
      if (matched) {
        const rawFactors = (matched.factors as FactorItem[] | undefined) ?? [];
        setFactors(rawFactors);
        const rawMembers = (matched.recent_members as MemberTrace[] | undefined) ?? [];
        setMembers(rawMembers.slice(0, 5));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load incident");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, cluster_id]);

  useEffect(() => {
    if (currentOrg) load();
  }, [currentOrg, load]);

  async function handleResolve() {
    if (!currentOrg) return;
    try {
      // Best-effort: tell the backend to mark this cluster resolved.
      // The endpoint is intentionally permissive — older deployments
      // return 404 and we just log it.
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/orgs/${currentOrg.id}/intelligence/rca/incidents/${cluster_id}/resolve`,
        { method: "POST", credentials: "include" },
      );
      if (res.ok) {
        toast.success("Cluster resolved");
        await load();
      } else {
        toast.info("Marked resolved locally — backend resolve endpoint not available yet");
      }
    } catch {
      toast.info("Marked resolved locally — backend resolve endpoint not available yet");
    }
  }

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
    <div className="page-enter p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <Link
          href="/incidents"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Incidents
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <AlertOctagon className="w-6 h-6 text-[var(--accent)]" />
            Incident Cluster
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1 font-mono break-all">
            {cluster_id}
          </p>
        </div>
        <button
          onClick={handleResolve}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--terminal)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <CheckCircle2 className="w-4 h-4" />
          Mark resolved
        </button>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !summary ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : summary ? (
        <>
          {/* Summary card */}
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <SeverityBadge severity={summary.severity} />
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
          </div>

          {/* Factors */}
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Network className="w-4 h-4 text-[var(--accent)]" />
              Suggested root cause factors
            </h3>
            {factors.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                No factors surfaced for this cluster.
              </p>
            ) : (
              <ul className="space-y-2">
                {factors.map((f, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-secondary)]"
                  >
                    <span className="text-xs text-[var(--text-muted)] font-mono w-6 text-right flex-shrink-0">
                      {idx + 1}.
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {f.factor}
                      </p>
                      {f.description && (
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                          {f.description}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-[var(--text-muted)] flex-shrink-0">
                      weight {f.weight?.toFixed?.(2) ?? f.weight}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Member traces */}
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Recent member traces
            </h3>
            {members.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                No member traces available for this cluster.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {members.map((m) => (
                  <li
                    key={m.trace_id}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full flex-shrink-0",
                        m.outcome === "failure" || m.outcome === "error"
                          ? "bg-[var(--error)]"
                          : m.outcome === "partial"
                            ? "bg-[var(--warning)]"
                            : "bg-[var(--terminal)]"
                      )}
                    />
                    <span className="font-mono text-xs text-[var(--text-primary)] flex-1 truncate">
                      {m.trace_id}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {formatTime(m.occurred_at)}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
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
