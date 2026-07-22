"use client";

import { useTranslations } from "next-intl";
import type { TraceSummaryMetrics } from "@/app/(portal)/_hooks/use-trace-detail";
import {
  formatCost,
  formatLatency,
  formatTokens,
} from "@/app/(portal)/traces/_lib/format";

type Props = {
  traceId: string;
  metrics: TraceSummaryMetrics;
  summaryTypes?: Record<string, number>;
  spanId?: string;
};

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono text-[var(--text-primary)]">{value}</span>
    </span>
  );
}

export function MetaCanvas({ traceId, metrics, summaryTypes, spanId }: Props) {
  const t = useTranslations("traces.meta");

  return (
    <div className="space-y-4 px-3 py-3" data-testid="meta-canvas" data-mode="meta">
      <div className="flex flex-wrap gap-2">
        <Pill label={t("traceId")} value={traceId} />
        {spanId ? <Pill label={t("spanId")} value={spanId} /> : null}
        {metrics.agentId ? (
          <Pill label={t("agent")} value={metrics.agentId} />
        ) : null}
        <Pill label={t("outcome")} value={metrics.outcome ?? "—"} />
        <Pill label={t("latency")} value={formatLatency(metrics.durationMs)} />
        <Pill label={t("tokens")} value={formatTokens(metrics.totalTokens)} />
        <Pill label={t("cost")} value={formatCost(metrics.costUsd)} />
        <Pill label={t("spans")} value={String(metrics.spanCount)} />
      </div>
      {summaryTypes && Object.keys(summaryTypes).length > 0 ? (
        <div>
          <p className="m-0 mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {t("eventTypes")}
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(summaryTypes).map(([type, count]) => (
              <Pill key={type} label={type} value={String(count)} />
            ))}
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-[var(--text-muted)]">{t("emptyTypes")}</p>
      )}
    </div>
  );
}
