"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { InfiniteDataTable } from "@/components/portal-os";
import type { DataTableColumn } from "@/components/ui/data-table";
import { agentSessionsApi, type AgentSessionRecord } from "@/lib/api";
import { fetchApi } from "@/lib/api/core";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, ExternalLink, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { SessionTurnTimeline } from "@/components/sessions/SessionTurnTimeline";
import {
  buildSessionTurns,
  type SessionTracePreviewRow,
} from "@/components/sessions/session-turn-preview";
import { sessionHref, type TracePreserveParams } from "@/lib/portal-cross-links";

export interface SessionsTabProps {
  orgId: string;
  agentId?: string;
  /** Hub QueryFilterBar outcome — no sibling filter band on this lens. */
  outcome?: string;
  /** Currently selected hub trace (highlight turn card). */
  selectedTraceId?: string;
  /** Open a nested turn in the traces detail panel (expand-in-place). */
  onSelectTrace?: (traceId: string) => void;
  /** @deprecated Prefer expand-in-place + onSelectTrace. */
  onSelectSession?: (sessionId: string) => void;
  /** Preserve hub filters on Open-trace deep links from turn cards. */
  preserve?: TracePreserveParams;
}

/**
 * Sessions lens — Laminar expand-in-place: click row to reveal numbered
 * turn cards (1/N) with Input + last LLM Output, then open a trace in the
 * hub detail panel without leaving `/traces?view=sessions`.
 */
export function SessionsTab({
  orgId,
  agentId,
  outcome,
  selectedTraceId,
  onSelectTrace,
  onSelectSession,
  preserve,
}: SessionsTabProps) {
  const [limit, setLimit] = useState(100);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sessionsQuery = useOrgQuery(
    queryKeys.agents.sessions(orgId, {
      ...(agentId ? { agent_id: agentId } : {}),
      limit,
    }),
    orgId,
    () =>
      agentSessionsApi
        .list(orgId, { ...(agentId ? { agent_id: agentId } : {}), limit })
        .then((res) => res.data?.sessions ?? []),
  );

  const sessions = useMemo(() => {
    const all = sessionsQuery.data ?? [];
    if (!outcome) return all;
    return all.filter((s) => {
      if (outcome === "success") return s.success === true;
      if (outcome === "failure") return s.success === false;
      if (outcome === "open" || outcome === "partial" || outcome === "timeout") {
        return s.success == null;
      }
      return true;
    });
  }, [sessionsQuery.data, outcome]);

  const expanded = sessions.find((s) => s.id === expandedId) ?? null;
  const expandedTraceIds = expanded?.trace_ids ?? [];
  const expandedTraceKey =
    expandedTraceIds.length > 0 ? expandedTraceIds.join(",") : null;

  const turnsQuery = useOrgQuery(
    queryKeys.agents.sessionTraces(orgId, expandedId, expandedTraceKey),
    orgId && expandedId && expandedTraceIds.length > 0 ? orgId : null,
    async () => {
      const ids = (expanded?.trace_ids ?? []).slice(0, 100);
      if (ids.length === 0) return [] as SessionTracePreviewRow[];
      const q = new URLSearchParams();
      for (const tid of ids) q.append("trace_ids", tid);
      q.set("limit", String(Math.min(100, Math.max(ids.length, 1))));
      const res = await fetchApi<{ traces: SessionTracePreviewRow[] }>(
        `/orgs/${orgId}/observability/traces?${q.toString()}`,
      );
      return res.traces ?? [];
    },
  );

  const turns = useMemo(
    () => buildSessionTurns(expanded?.trace_ids ?? [], turnsQuery.data ?? []),
    [expanded?.trace_ids, turnsQuery.data],
  );

  const columns: DataTableColumn<AgentSessionRecord>[] = useMemo(
    () => [
      {
        key: "id",
        header: "Session",
        sticky: true,
        sortable: true,
        cell: (s) => {
          const open = expandedId === s.id;
          return (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs">
              {open ? (
                <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden />
              )}
              <span className="text-[var(--text-primary)]">{s.id.slice(0, 16)}…</span>
            </span>
          );
        },
      },
      {
        key: "turns",
        header: "Turns",
        align: "right",
        sortable: true,
        cell: (s) => (
          <span className="text-xs tabular-nums">{s.trace_ids?.length ?? 0}</span>
        ),
      },
      {
        key: "agent_id",
        header: "Agent",
        sortable: true,
        cell: (s) => (
          <span className="text-xs text-[var(--text-secondary)]">{s.agent_id ?? "—"}</span>
        ),
      },
      {
        key: "user_id",
        header: "User",
        cell: (s) => (
          <span className="text-xs text-[var(--text-secondary)]">{s.user_id ?? "—"}</span>
        ),
      },
      {
        key: "success",
        header: "Outcome",
        sortable: true,
        cell: (s) => {
          const sessionOutcome =
            s.success === true ? "success" : s.success === false ? "failure" : "open";
          const Icon =
            sessionOutcome === "success"
              ? CheckCircle2
              : sessionOutcome === "failure"
                ? XCircle
                : Circle;
          const iconClass =
            sessionOutcome === "success"
              ? "text-[var(--success)]"
              : sessionOutcome === "failure"
                ? "text-[var(--error)]"
                : "text-[var(--text-muted)]";
          return <Icon className={cn("h-4 w-4", iconClass)} aria-label={sessionOutcome} />;
        },
      },
      {
        key: "started_at",
        header: "Last activity",
        sortable: true,
        cell: (s) => (
          <time className="text-xs text-[var(--text-muted)]" dateTime={s.started_at}>
            {s.started_at ? new Date(s.started_at).toLocaleString() : "—"}
          </time>
        ),
      },
    ],
    [expandedId],
  );

  const listError = sessionsQuery.isError;
  const errorMessage = sessionsQuery.error?.message ?? null;

  return (
    <div className="space-y-space-2" data-testid="sessions-table">
      {listError ? (
        <ErrorState
          title="Could not load sessions"
          message={errorMessage ?? "Unknown error"}
          action={
            <Button
              variant="outline"
              onClick={() => void sessionsQuery.refetch()}
              loading={sessionsQuery.isFetching}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <InfiniteDataTable
            columns={columns}
            rows={sessions}
            loading={sessionsQuery.isLoading}
            rowKey={(s) => s.id}
            onRowClick={(s) => {
              setExpandedId((cur) => (cur === s.id ? null : s.id));
              onSelectSession?.(s.id);
            }}
            selectable
            defaultSort={{ key: "started_at", direction: "desc" }}
            emptyTitle="No sessions yet"
            emptyDescription="Use eden.session / begin() in the SDK to group multi-turn traces."
            hasMore={(sessionsQuery.data?.length ?? 0) >= limit}
            onLoadMore={() => setLimit((n) => n + 100)}
          />
          {expanded ? (
            <div
              className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-3"
              data-testid="session-expand-panel"
              aria-label={`Turns in session ${expanded.id}`}
            >
              <div className="mb-space-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-[var(--text-primary)]">
                  {expandedTraceIds.length} turn
                  {expandedTraceIds.length === 1 ? "" : "s"}
                </p>
                <Link
                  href={sessionHref(expanded.id, preserve)}
                  className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                >
                  Open session page
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              </div>
              {expandedTraceIds.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">No traces linked yet.</p>
              ) : turnsQuery.isLoading ? (
                <LoadingSkeleton variant="default" lines={3} />
              ) : turnsQuery.isError ? (
                <ErrorState
                  title="Could not load turns"
                  message={turnsQuery.error?.message ?? "Unknown error"}
                  action={
                    <Button
                      variant="outline"
                      onClick={() => void turnsQuery.refetch()}
                      loading={turnsQuery.isFetching}
                    >
                      Try again
                    </Button>
                  }
                />
              ) : (
                <SessionTurnTimeline
                  turns={turns}
                  selectedTraceId={selectedTraceId}
                  layout="stack"
                  openTraceView="sessions"
                  preserve={preserve}
                  onSelectTurn={(tid) => onSelectTrace?.(tid)}
                />
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
