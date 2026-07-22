"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { DiagnosisStrip } from "@/components/shell/diagnosis-strip";
import { MetricInline } from "@/components/ui/metric-inline";
import { Button } from "@/components/ui/button";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useSessionDetail } from "@/app/(portal)/_hooks/use-session-detail";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortId,
} from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type Props = {
  sessionId: string;
  selectedTraceId?: string;
  onSelectTurn: (traceId: string) => void;
  onOpenTranscript: (traceId: string) => void;
};

export function SessionReader({
  sessionId,
  selectedTraceId,
  onSelectTurn,
  onOpenTranscript,
}: Props) {
  const t = useTranslations("sessions.reader");
  const detail = useSessionDetail(sessionId);

  if (detail.loading) {
    return (
      <div className="space-y-3 p-3" data-testid="session-reader-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (detail.notFound) {
    return (
      <div className="p-4" data-testid="session-reader-not-found">
        <p className="m-0 text-sm text-[var(--text-secondary)]">{t("notFound")}</p>
      </div>
    );
  }

  const issueHref = detail.diagnosis.primaryHref;
  const canCreateIssue = Boolean(sessionId);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="session-reader">
      <div className="space-y-1">
        <p className="m-0 font-mono text-sm text-[var(--text-primary)]">
          {shortId(sessionId, 12)}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-[var(--text-secondary)]">
            {detail.session?.agent_id ?? "—"}
          </span>
          <span className="text-[var(--text-muted)]">
            {t("turns", { count: detail.turns.length })}
          </span>
          <MetricInline
            label={t("latency")}
            value={formatLatency(detail.aggregates.latencyMs)}
            mono
          />
          <MetricInline
            label={t("tokens")}
            value={formatTokens(detail.aggregates.totalTokens)}
            mono
          />
          <MetricInline
            label={t("cost")}
            value={formatCost(detail.aggregates.costUsd)}
            mono
          />
        </div>
      </div>

      <DiagnosisStrip
        diagnosis={detail.diagnosis}
        isHealthy={!detail.hasError}
        testId="session-diagnosis"
        label={t("diagnosisLabel")}
        title={
          detail.hasError
            ? detail.errorSummary ?? t("diagnosisError")
            : t("diagnosisOk")
        }
        description={
          detail.hasError ? t("diagnosisErrorBody") : t("diagnosisOkBody")
        }
        ctaLabel={t("createIssue")}
      />

      {detail.zeroTurns ? (
        <div className="space-y-2 py-4" data-testid="session-zero-turns">
          <p className="m-0 text-sm text-[var(--text-muted)]">{t("zeroTurns")}</p>
          <Button type="button" size="sm" variant="secondary" onClick={detail.refetch}>
            {t("retry")}
          </Button>
        </div>
      ) : (
        <div data-testid="session-turn-timeline">
          <p className="m-0 mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {t("turnList")}
          </p>
          <ul className="m-0 list-none space-y-0 p-0">
            {detail.turns.map((turn) => {
              const selected = turn.traceId === selectedTraceId;
              return (
                <li key={turn.traceId}>
                  <button
                    type="button"
                    data-trace-id={turn.traceId}
                    data-selected={selected ? "true" : "false"}
                    className={cn(
                      "flex w-full flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-1 py-2.5 text-left text-sm",
                      "hover:bg-[var(--bg-tertiary)]",
                      selected && "bg-[var(--bg-tertiary)]",
                    )}
                    onClick={() => onSelectTurn(turn.traceId)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span className="text-[var(--text-muted)]">{turn.index}</span>
                      <span className="font-mono text-xs text-[var(--text-secondary)]">
                        {shortId(turn.traceId)}
                      </span>
                      <TraceOutcomeBadge outcome={turn.outcome} />
                    </span>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <MetricInline
                        label=""
                        value={formatLatency(turn.latencyMs)}
                        mono
                      />
                      <MetricInline
                        label=""
                        value={formatTokens(turn.totalTokens)}
                        mono
                      />
                      <MetricInline
                        label=""
                        value={formatCost(turn.costUsd)}
                        mono
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {selectedTraceId ? (
          <Button
            type="button"
            size="sm"
            onClick={() => onOpenTranscript(selectedTraceId)}
            data-testid="session-open-transcript"
          >
            {t("openTranscript")}
          </Button>
        ) : null}
        {canCreateIssue ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={issueHref}>{t("createIssue")}</Link>
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled title={t("createIssueUnavailable")}>
            {t("createIssue")}
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link
            href={
              selectedTraceId
                ? `/debugger?traceId=${encodeURIComponent(selectedTraceId)}&sessionId=${encodeURIComponent(sessionId)}`
                : `/debugger?sessionId=${encodeURIComponent(sessionId)}`
            }
          >
            {t("debugger")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
