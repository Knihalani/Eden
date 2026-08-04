"use client";

/**
 * Agent detail health header strip — derives a single health status from
 * the fixture row via src/lib/agent-health.ts and renders it with the
 * shared AGENT_HEALTH_STATUSES descriptors.
 */

import {
  AGENT_HEALTH_STATUSES,
  deriveAgentStatus,
} from "@/lib/agent-health";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";

export function AgentHealthStrip({
  lastSeen,
  errorRate,
  openIssues,
  runs24h,
}: {
  lastSeen: string | null | undefined;
  errorRate: number | null | undefined;
  openIssues: number;
  runs24h: number;
}) {
  const status = deriveAgentStatus({
    lastSeenAt: lastSeen ?? null,
    errorRate: errorRate ?? null,
    openIssueCount: openIssues,
    hasTrafficInWindow: runs24h > 0,
  });
  const descriptor = AGENT_HEALTH_STATUSES[status];
  const Icon = descriptor.icon;

  const parts: string[] = [];
  if (runs24h > 0) parts.push(`${runs24h} runs (24h)`);
  if (errorRate != null && Number.isFinite(errorRate)) {
    parts.push(`${(errorRate * 100).toFixed(0)}% errors`);
  }
  if (openIssues > 0) parts.push(`${openIssues} open issues`);
  if (lastSeen) parts.push(`last seen ${formatRelativeTime(lastSeen)}`);

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-2 sm:px-6"
      role="status"
      aria-label={`Agent health: ${descriptor.label}`}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 text-[0.7rem] font-medium",
          descriptor.className,
        )}
      >
        {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
        {descriptor.label}
      </span>
      {parts.length > 0 ? (
        <span className="type-meta">{parts.join(" · ")}</span>
      ) : (
        <span className="type-meta">No telemetry yet</span>
      )}
    </div>
  );
}
