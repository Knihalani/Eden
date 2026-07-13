"use client";

import Link from "next/link";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentSessionTimelineItem = {
  id: string;
  agent_id?: string | null;
  user_id?: string | null;
  success?: boolean | null;
  failure_reason?: string | null;
  trace_ids?: string[];
  started_at?: string;
  ended_at?: string | null;
};

export interface SessionTimelineProps {
  sessions: AgentSessionTimelineItem[];
  orgId?: string;
  className?: string;
}

export function SessionTimeline({ sessions, orgId, className }: SessionTimelineProps) {
  if (sessions.length === 0) {
    return (
      <p className={cn("text-sm text-[var(--text-muted)]", className)}>
        No agent sessions yet. Use the SDK <code className="text-xs">begin()</code> API.
      </p>
    );
  }

  return (
    <ul className={cn("space-y-3", className)} role="list">
      {sessions.map((s) => {
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

        return (
          <li
            key={s.id}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-3"
          >
            <div className="flex items-start gap-2">
              <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", iconClass)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                  <span className="font-mono truncate">{s.id}</span>
                  {s.agent_id && <span>agent: {s.agent_id}</span>}
                  {s.started_at && (
                    <time dateTime={s.started_at}>
                      {new Date(s.started_at).toLocaleString()}
                    </time>
                  )}
                </div>
                {s.failure_reason && (
                  <p className="mt-1 text-sm text-[var(--error)]">{s.failure_reason}</p>
                )}
                {(s.trace_ids?.length ?? 0) > 0 && (
                  <ul className="mt-2 space-y-1">
                    {s.trace_ids!.map((tid) => (
                      <li key={tid}>
                        <Link
                          href={`/traces/${tid}${orgId ? `?org=${orgId}` : ""}`}
                          className="text-xs font-mono text-[var(--accent)] hover:underline break-all"
                        >
                          {tid}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
