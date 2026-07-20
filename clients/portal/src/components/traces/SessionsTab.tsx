"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { InfiniteDataTable } from "@/components/portal-os";
import type { DataTableColumn } from "@/components/ui/data-table";
import { agentSessionsApi, type AgentSessionRecord } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";

export interface SessionsTabProps {
  orgId: string;
  agentId?: string;
  /** Hub QueryFilterBar outcome — no sibling filter band on this lens. */
  outcome?: string;
  onSelectSession: (sessionId: string) => void;
}

/**
 * Sessions lens — shares hub toolbar grammar.
 * Outcome comes from hub filters (`?outcome=`), not a local chrome row.
 */
export function SessionsTab({
  orgId,
  agentId,
  outcome,
  onSelectSession,
}: SessionsTabProps) {
  const [limit, setLimit] = useState(100);

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

  const columns: DataTableColumn<AgentSessionRecord>[] = useMemo(
    () => [
      {
        key: "id",
        header: "Session",
        sticky: true,
        sortable: true,
        cell: (s) => (
          <Link
            href={`/sessions/${encodeURIComponent(s.id)}`}
            className="font-mono text-xs text-[var(--accent)] hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {s.id.slice(0, 16)}…
          </Link>
        ),
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
    [],
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
        <InfiniteDataTable
          columns={columns}
          rows={sessions}
          loading={sessionsQuery.isLoading}
          rowKey={(s) => s.id}
          onRowClick={(s) => onSelectSession(s.id)}
          selectable
          defaultSort={{ key: "started_at", direction: "desc" }}
          emptyTitle="No sessions yet"
          emptyDescription="Use eden.session / begin() in the SDK to group multi-turn traces."
          hasMore={(sessionsQuery.data?.length ?? 0) >= limit}
          onLoadMore={() => setLimit((n) => n + 100)}
        />
      )}
    </div>
  );
}
