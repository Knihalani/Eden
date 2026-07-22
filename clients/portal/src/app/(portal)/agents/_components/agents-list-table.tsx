"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { MetricInline } from "@/components/ui/metric-inline";
import {
  AGENT_HEALTH_STATUSES,
  type AgentOsRow,
} from "@/lib/agent-health";
import { cn } from "@/lib/utils";

function formatRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type Props = {
  rows: AgentOsRow[];
  focusedIndex?: number;
  onFocusIndex?: (index: number) => void;
};

export function AgentsListTable({
  rows,
  focusedIndex = -1,
  onFocusIndex,
}: Props) {
  const t = useTranslations("agents.list");
  const router = useRouter();

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="agents-list-table">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colName")}</th>
            <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
            <th className="px-3 py-2 font-medium">{t("colLastSeen")}</th>
            <th className="px-3 py-2 font-medium">{t("colErrorRate")}</th>
            <th className="px-3 py-2 font-medium">{t("colCost")}</th>
            <th className="px-3 py-2 font-medium">{t("colIssues")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.agentId}
              tabIndex={0}
              data-focused={focusedIndex === index ? "true" : "false"}
              className={cn(
                "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                focusedIndex === index && "bg-[var(--bg-tertiary)]",
              )}
              onClick={() => router.push(`/agents/${encodeURIComponent(row.agentId)}`)}
              onFocus={() => onFocusIndex?.(index)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  router.push(`/agents/${encodeURIComponent(row.agentId)}`);
                }
              }}
            >
              <td className="px-3 py-2.5">
                <Link
                  href={`/agents/${encodeURIComponent(row.agentId)}`}
                  className="font-medium text-[var(--text-primary)] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.displayName}
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge
                  status={row.status}
                  descriptors={AGENT_HEALTH_STATUSES}
                />
              </td>
              <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                {formatRelative(row.lastSeenAt)}
              </td>
              <td className="px-3 py-2.5">
                <MetricInline
                  label=""
                  value={formatRate(row.errorRate)}
                  mono
                />
              </td>
              <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                {formatUsd(row.costUsd)}
              </td>
              <td className="px-3 py-2.5">
                {row.openIssueCount > 0 ? (
                  <Link
                    href={`/issues?agentId=${encodeURIComponent(row.agentId)}`}
                    className="text-[var(--accent)] hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {row.openIssueCount}
                  </Link>
                ) : (
                  <span className="text-[var(--text-muted)]">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
