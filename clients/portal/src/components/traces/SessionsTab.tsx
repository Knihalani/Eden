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

export interface SessionsTabProps {
  orgId: string;
  agentId?: string;
  onSelectSession: (sessionId: string) => void;
}

export function SessionsTab({ orgId, agentId, onSelectSession }: SessionsTabProps) {
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "success" | "failure" | "open">("all");
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
    if (outcomeFilter === "all") return all;
    return all.filter((s) => {
      if (outcomeFilter === "success") return s.success === true;
      if (outcomeFilter === "failure") return s.success === false;
      return s.success == null;
    });
  }, [sessionsQuery.data, outcomeFilter]);

  const columns: DataTableColumn<AgentSessionRecord>[] = useMemo(
    () => [
      {
        key: "id",
        header: "Session",
        sticky: true,
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
        cell: (s) => (
          <span className="text-xs tabular-nums">{s.trace_ids?.length ?? 0}</span>
        ),
      },
      {
        key: "agent_id",
        header: "Agent",
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
        cell: (s) => {
          const outcome =
            s.success === true ? "success" : s.success === false ? "failure" : "open";
          const Icon =
            outcome === "success" ? CheckCircle2 : outcome === "failure" ? XCircle : Circle;
          const iconClass =
            outcome === "success"
              ? "text-[var(--success)]"
              : outcome === "failure"
                ? "text-[var(--error)]"
                : "text-[var(--text-muted)]";
          return <Icon className={cn("h-4 w-4", iconClass)} aria-label={outcome} />;
        },
      },
      {
        key: "started_at",
        header: "Last activity",
        cell: (s) => (
          <time className="text-xs text-[var(--text-muted)]" dateTime={s.started_at}>
            {s.started_at ? new Date(s.started_at).toLocaleString() : "—"}
          </time>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
        <span className="text-[var(--text-muted)]">Outcome</span>
        {(["all", "success", "failure", "open"] as const).map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setOutcomeFilter(o)}
            className={cn(
              "px-2 py-0.5 rounded border capitalize",
              outcomeFilter === o
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border-subtle)] text-[var(--text-muted)]",
            )}
          >
            {o}
          </button>
        ))}
      </div>
      <InfiniteDataTable
        columns={columns}
        rows={sessions}
        loading={sessionsQuery.isLoading}
        rowKey={(s) => s.id}
        onRowClick={(s) => onSelectSession(s.id)}
        emptyTitle="No sessions yet"
        emptyDescription="Use eden.session / begin() in the SDK to group multi-turn traces."
        hasMore={(sessionsQuery.data?.length ?? 0) >= limit}
        onLoadMore={() => setLimit((n) => n + 100)}
      />
    </div>
  );
}
