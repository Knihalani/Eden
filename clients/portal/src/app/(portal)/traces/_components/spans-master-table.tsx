"use client";

import { useTranslations } from "next-intl";
import { MetricInline } from "@/components/ui/metric-inline";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import type { SpanListRow } from "@/app/(portal)/_hooks/use-traces-hub-data";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortId,
} from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type Props = {
  rows: SpanListRow[];
  selectedTraceId?: string;
  selectedSpanId?: string;
  focusedIndex?: number;
  onSelect: (traceId: string, spanId: string) => void;
  onFocusIndex?: (index: number) => void;
};

export function SpansMasterTable({
  rows,
  selectedTraceId,
  selectedSpanId,
  focusedIndex = -1,
  onSelect,
  onFocusIndex,
}: Props) {
  const t = useTranslations("traces.table");

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="spans-master-table">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colName")}</th>
            <th className="px-3 py-2 font-medium">{t("colTrace")}</th>
            <th className="px-3 py-2 font-medium">{t("colOutcome")}</th>
            <th className="px-3 py-2 font-medium">{t("colMetrics")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected =
              row.traceId === selectedTraceId &&
              row.spanId === selectedSpanId;
            const focused = focusedIndex === index;
            return (
              <tr
                key={`${row.traceId}:${row.spanId}`}
                tabIndex={0}
                data-span-id={row.spanId}
                data-trace-id={row.traceId}
                data-selected={selected ? "true" : "false"}
                data-focused={focused ? "true" : "false"}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                  "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                  (selected || focused) && "bg-[var(--bg-tertiary)]",
                )}
                onClick={() => onSelect(row.traceId, row.spanId)}
                onFocus={() => onFocusIndex?.(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.traceId, row.spanId);
                }}
              >
                <td className="px-3 py-2.5 font-medium text-[var(--text-primary)]">
                  {row.name}
                  {row.preview ? (
                    <p className="m-0 mt-0.5 truncate text-xs font-normal text-[var(--text-muted)]">
                      {row.preview}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-[var(--text-secondary)]">
                  {shortId(row.traceId)}
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
