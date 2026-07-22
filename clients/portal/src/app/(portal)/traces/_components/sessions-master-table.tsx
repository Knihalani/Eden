"use client";

import { useTranslations } from "next-intl";
import { MetricInline } from "@/components/ui/metric-inline";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import type { SessionListRow } from "@/app/(portal)/_hooks/use-traces-hub-data";
import {
  formatCost,
  formatLatency,
  formatRelativeTime,
  formatTokens,
} from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type Props = {
  rows: SessionListRow[];
  selectedSessionId?: string;
  focusedIndex?: number;
  onSelect: (sessionId: string) => void;
  onFocusIndex?: (index: number) => void;
};

export function SessionsMasterTable({
  rows,
  selectedSessionId,
  focusedIndex = -1,
  onSelect,
  onFocusIndex,
}: Props) {
  const t = useTranslations("sessions.table");

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="sessions-master-table">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colTime")}</th>
            <th className="px-3 py-2 font-medium">{t("colAgent")}</th>
            <th className="px-3 py-2 font-medium">{t("colTurns")}</th>
            <th className="px-3 py-2 font-medium">{t("colOutcome")}</th>
            <th className="px-3 py-2 font-medium">{t("colMetrics")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = row.sessionId === selectedSessionId;
            const focused = focusedIndex === index;
            return (
              <tr
                key={row.sessionId}
                tabIndex={0}
                data-session-id={row.sessionId}
                data-selected={selected ? "true" : "false"}
                data-focused={focused ? "true" : "false"}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                  "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                  (selected || focused) && "bg-[var(--bg-tertiary)]",
                )}
                onClick={() => onSelect(row.sessionId)}
                onFocus={() => onFocusIndex?.(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.sessionId);
                }}
              >
                <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                  {formatRelativeTime(row.startedAt)}
                </td>
                <td className="px-3 py-2.5 text-[var(--text-primary)]">
                  {row.agentId ?? "—"}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-[var(--text-secondary)]">
                  {row.turnCount}
                </td>
                <td className="px-3 py-2.5">
                  <TraceOutcomeBadge outcome={row.outcome} />
                </td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <MetricInline
                      label={t("latency")}
                      value={formatLatency(row.latencyMs)}
                      mono
                    />
                    <MetricInline
                      label={t("tokens")}
                      value={formatTokens(row.totalTokens)}
                      mono
                    />
                    <MetricInline
                      label={t("cost")}
                      value={formatCost(row.costUsd)}
                      mono
                    />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
