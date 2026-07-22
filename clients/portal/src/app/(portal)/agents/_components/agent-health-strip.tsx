"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { CodeChip } from "@/components/ui/code-chip";
import { Panel } from "@/components/ui/panel";
import { MetricInline } from "@/components/ui/metric-inline";
import {
  AGENT_HEALTH_STATUSES,
  type AgentHealthStatus,
} from "@/lib/agent-health";

type Props = {
  status: AgentHealthStatus;
  agentId: string;
  lastSeenAt: string | null;
  errorRate: number | null;
  openIssueCount: number;
};

export function AgentHealthStrip({
  status,
  agentId,
  lastSeenAt,
  errorRate,
  openIssueCount,
}: Props) {
  const t = useTranslations("agents.detail");

  return (
    <Panel
      tone="tint"
      padding="md"
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="agent-health-strip"
      role="region"
      aria-label={t("healthRegion")}
    >
      <div className="flex flex-wrap items-center gap-3 min-w-0">
        <StatusBadge status={status} descriptors={AGENT_HEALTH_STATUSES} />
        <CodeChip size="sm">{agentId}</CodeChip>
        <MetricInline
          label={t("lastSeen")}
          value={
            lastSeenAt
              ? new Date(lastSeenAt).toLocaleString()
              : t("neverSeen")
          }
        />
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <MetricInline
          label={t("errorRate")}
          value={
            errorRate != null ? `${(errorRate * 100).toFixed(1)}%` : "—"
          }
          mono
        />
        <Link
          href={`/issues?agentId=${encodeURIComponent(agentId)}`}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          {t("openIssues", { count: openIssueCount })}
        </Link>
      </div>
    </Panel>
  );
}
