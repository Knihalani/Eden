"use client";

import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSessionRecord } from "@/lib/api";

export interface SessionHeaderProps {
  session: AgentSessionRecord;
  traceSummaries?: Array<{
    trace_id: string;
    duration_ms?: number;
    cost_cents?: number | null;
    outcome?: string | null;
  }>;
}

export function SessionHeader({ session, traceSummaries = [] }: SessionHeaderProps) {
  const turns = session.trace_ids?.length ?? traceSummaries.length;
  const totalCostCents = traceSummaries.reduce((sum, t) => sum + (t.cost_cents ?? 0), 0);
  const totalDuration = traceSummaries.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0);
  const outcome =
    session.success === true ? "success" : session.success === false ? "failure" : "live";
  const Icon =
    outcome === "success" ? CheckCircle2 : outcome === "failure" ? XCircle : Circle;

  return (
    <header className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <Icon
          className={cn(
            "h-5 w-5 mt-0.5 shrink-0",
            outcome === "success"
              ? "text-[var(--success)]"
              : outcome === "failure"
                ? "text-[var(--error)]"
                : "text-[var(--text-muted)]",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            Session · D12 eden-agent-session-v1
          </p>
          <p className="font-mono text-sm text-[var(--text-primary)] break-all">{session.id}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <dt className="text-[var(--text-muted)]">Turns</dt>
          <dd className="font-medium text-[var(--text-primary)]">{turns}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Duration</dt>
          <dd className="font-medium">{totalDuration > 0 ? `${totalDuration.toFixed(0)}ms` : "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Cost</dt>
          <dd className="font-mono font-medium">
            {totalCostCents > 0 ? `$${(totalCostCents / 100).toFixed(2)}` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">User</dt>
          <dd>{session.user_id ?? "—"}</dd>
        </div>
        {session.agent_id && (
          <div>
            <dt className="text-[var(--text-muted)]">Agent</dt>
            <dd>{session.agent_id}</dd>
          </div>
        )}
        {session.failure_reason && (
          <div className="col-span-full">
            <dt className="text-[var(--text-muted)]">Failure</dt>
            <dd className="text-[var(--error)]">{session.failure_reason}</dd>
          </div>
        )}
      </dl>
    </header>
  );
}
