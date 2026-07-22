"use client";

import { useTranslations } from "next-intl";
import { MetricInline } from "@/components/ui/metric-inline";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import type { TraceListRow } from "@/app/(portal)/_hooks/use-traces-hub-data";
import {
  formatCost,
  formatLatency,
  formatRelativeTime,
  formatTokens,
  shortId,
} from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type Props = {
  rows: TraceListRow[];
  selectedTraceId?: string;
  focusedIndex?: number;
  onSelect: (traceId: string) => void;
  onFocusIndex?: (index: number) => void;
};

export function TracesMasterTable({
  rows,
  selectedTraceId,
  focusedIndex = -1,
  onSelect,
  onFocusIndex,
}: Props) {
  const t = useTranslations("traces.table");

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="traces-master-table">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colTime")}</th>
            <th className="px-3 py-2 font-medium">{t("colAgent")}</th>
            <th className="px-3 py-2 font-medium">{t("colOutcome")}</th>
            <th className="px-3 py-2 font-medium">{t("colPreview")}</th>
            <th className="px-3 py-2 font-medium">{t("colMetrics")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = row.traceId === selectedTraceId;
            const focused = focusedIndex === index;
            return (
              <tr
                key={row.traceId}
                tabIndex={0}
                data-trace-id={row.traceId}
                data-selected={selected ? "true" : "false"}
                data-focused={focused ? "true" : "false"}
                data-live={row.isLive ? "true" : undefined}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                  "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                  (selected || focused) && "bg-[var(--bg-tertiary)]",
                  row.isLive && "animate-pulse",
                )}
                onClick={() => onSelect(row.traceId)}
                onFocus={() => onFocusIndex?.(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.traceId);
                }}
              >
                <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                  {formatRelativeTime(row.startedAt)}
                </td>
                <td className="px-3 py-2.5 text-[var(--text-primary)]">
                  {row.agentId ?? "—"}
                </td>
                <td className="px-3 py-2.5">
                  <TraceOutcomeBadge outcome={row.outcome} />
                </td>
                <td className="max-w-[12rem] truncate px-3 py-2.5 font-mono text-xs text-[var(--text-muted)]">
                  {row.errorSummary ?? row.inputPreview ?? shortId(row.traceId)}
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
