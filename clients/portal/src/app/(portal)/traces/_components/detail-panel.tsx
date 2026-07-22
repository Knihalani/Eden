"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { DiagnosisStrip } from "@/components/shell/diagnosis-strip";
import { MetricInline } from "@/components/ui/metric-inline";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AddToDatasetDialog } from "@/components/evals/add-to-dataset-dialog";
import { useTraceDetail } from "@/app/(portal)/_hooks/use-trace-detail";
import { OBSERVE_MODES, type ObserveMode } from "@/lib/observe-url";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortId,
} from "@/app/(portal)/traces/_lib/format";
import { ModeTabs } from "./mode-tabs";
import { TranscriptCanvas } from "./transcript-canvas";
import { TreeCanvas } from "./tree-canvas";
import { TimelineCanvas } from "./timeline-canvas";
import { MetaCanvas } from "./meta-canvas";
import { ScoresCanvas } from "./scores-canvas";
import { SessionReader } from "./session-reader";

type Props = {
  open: boolean;
  onClose: () => void;
  /** When set without traceId (sessions lens), show session reader. */
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  mode: ObserveMode;
  pastHours: number;
  agentId?: string;
  onModeChange: (mode: ObserveMode) => void;
  onSpanSelect: (spanId: string) => void;
  onSelectTurn: (traceId: string) => void;
  onOpenTranscript: (traceId: string) => void;
};

export function TraceDetailPanel({
  open,
  onClose,
  sessionId,
  traceId,
  spanId,
  mode,
  pastHours,
  agentId,
  onModeChange,
  onSpanSelect,
  onSelectTurn,
  onOpenTranscript,
}: Props) {
  const t = useTranslations("traces.detail");
  const tEvals = useTranslations("evals.addToDataset");
  const showSessionOnly = Boolean(sessionId) && !traceId;
  const detail = useTraceDetail(traceId, { pastHours, agentId });
  const [addToDatasetOpen, setAddToDatasetOpen] = useState(false);

  useEffect(() => {
    if (!open || !traceId) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < OBSERVE_MODES.length) {
        e.preventDefault();
        onModeChange(OBSERVE_MODES[idx]!);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, traceId, onModeChange]);

  const title = showSessionOnly
    ? shortId(sessionId ?? "", 12)
    : shortId(traceId ?? "", 12);

  const issueParams = new URLSearchParams();
  if (traceId) issueParams.set("traceId", traceId);
  if (spanId) issueParams.set("spanId", spanId);
  if (sessionId) issueParams.set("sessionId", sessionId);
  if (agentId || detail.metrics.agentId) {
    issueParams.set("agentId", agentId ?? detail.metrics.agentId ?? "");
  }
  const issueHref = `/issues?${issueParams.toString()}`;
  const debuggerHref = `/debugger?traceId=${encodeURIComponent(traceId ?? "")}${
    sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""
  }`;
  const improveHref = `/improve?tab=plans&traceId=${encodeURIComponent(traceId ?? "")}`;

  const headerActions = showSessionOnly ? null : (
    <div className="flex items-center gap-1">
      <Button asChild size="sm" className="min-h-9">
        <Link href={issueHref} data-testid="trace-create-issue">
          {t("createIssue")}
        </Link>
      </Button>
    </div>
  );

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={title}
      headerActions={headerActions}
      mobileDrawer
    >
      {showSessionOnly && sessionId ? (
        <SessionReader
          sessionId={sessionId}
          selectedTraceId={traceId}
          onSelectTurn={onSelectTurn}
          onOpenTranscript={onOpenTranscript}
        />
      ) : null}

      {traceId ? (
        <div className="flex flex-col gap-3 p-3" data-testid="trace-detail-body">
          {detail.loading ? (
            <div className="space-y-2" data-testid="trace-detail-loading">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.notFound ? (
            <div data-testid="trace-not-found">
              <p className="m-0 text-sm text-[var(--text-secondary)]">
                {t("notFound")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={onClose}
              >
                {t("clearSelection")}
              </Button>
            </div>
          ) : (
            <>
              <DiagnosisStrip
                diagnosis={{
                  ...detail.diagnosis,
                  primaryHref: issueHref,
                }}
                isHealthy={!detail.hasError}
                testId="trace-diagnosis"
                label={t("diagnosisLabel")}
                title={
                  detail.hasError
                    ? detail.errorSummary ?? t("diagnosisError")
                    : t("diagnosisOk")
                }
                description={
                  detail.hasError
                    ? t("diagnosisErrorBody")
                    : t("diagnosisOkBody")
                }
                ctaLabel={t("createIssue")}
              />

              <div
                className="flex flex-wrap items-center gap-3 text-sm"
                data-testid="trace-summary-meta"
              >
                <MetricInline
                  label={t("latency")}
                  value={formatLatency(detail.metrics.durationMs)}
                  mono
                />
                <MetricInline
                  label={t("tokens")}
                  value={formatTokens(detail.metrics.totalTokens)}
                  mono
                />
                <MetricInline
                  label={t("cost")}
                  value={formatCost(detail.metrics.costUsd)}
                  mono
                />
                {detail.metrics.agentId ? (
                  <span className="text-[var(--text-secondary)]">
                    {detail.metrics.agentId}
                  </span>
                ) : null}
              </div>

              <ModeTabs mode={mode} onModeChange={onModeChange} />

              <div data-testid="trace-mode-canvas">
                {mode === "transcript" ? (
                  <TranscriptCanvas
                    rows={detail.transcriptRows}
                    selectedSpanId={spanId}
                    onSelectSpan={onSpanSelect}
                  />
                ) : null}
                {mode === "tree" ? (
                  <TreeCanvas
                    rows={detail.treeRows}
                    selectedSpanId={spanId}
                    onSelectSpan={onSpanSelect}
                  />
                ) : null}
                {mode === "timeline" ? (
                  <TimelineCanvas
                    steps={detail.timeline?.steps ?? []}
                    totalDurationMs={
                      detail.timeline?.total_duration_ms ??
                      detail.metrics.durationMs ??
                      0
                    }
                    selectedSpanId={spanId}
                    onSelectSpan={onSpanSelect}
                  />
                ) : null}
                {mode === "meta" ? (
                  <MetaCanvas
                    traceId={traceId}
                    metrics={detail.metrics}
                    summaryTypes={detail.summary?.types}
                    spanId={spanId}
                  />
                ) : null}
                {mode === "scores" ? (
                  <ScoresCanvas
                    scores={detail.scores}
                    loading={detail.scoresLoading}
                    traceId={traceId}
                  />
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-3">
                <Button asChild size="sm" variant="secondary">
                  <Link href={issueHref}>{t("createIssue")}</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href={debuggerHref}>{t("debugger")}</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href={improveHref}>{t("improve")}</Link>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setAddToDatasetOpen(true)}
                  data-testid="trace-add-to-dataset"
                >
                  {tEvals("trigger")}
                </Button>
              </div>
              <AddToDatasetDialog
                open={addToDatasetOpen}
                onOpenChange={setAddToDatasetOpen}
                traceId={traceId}
                spanId={spanId}
                agentId={agentId ?? detail.metrics?.agentId ?? undefined}
              />
            </>
          )}
        </div>
      ) : null}
    </DetailPanelShell>
  );
}

/** Alias used by mobile Sheet path — same panel, mobileDrawer handles layout. */
export function TraceDetailSheet(props: Props) {
  return <TraceDetailPanel {...props} />;
}
