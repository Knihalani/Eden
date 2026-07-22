"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import { preserveFromSearchParams } from "@/lib/portal-cross-links";
import { findRowBySpanId } from "@/components/transcript-v2/transcript-reader-chrome";
import { UnifiedTopBar, TraceViewerLiveSlot } from "./UnifiedTopBar";
import { SpanNavTree } from "./SpanNavTree";
import { useTraceViewerData } from "./use-trace-viewer-data";
import { useTraceViewerSelection } from "./use-trace-viewer-selection";
import { SpanInspector } from "./SpanInspector";
import { TranscriptCanvas } from "./canvases/TranscriptCanvas";
import { TimelineCanvas } from "./canvases/TimelineCanvas";
import { MetadataCanvas } from "./canvases/MetadataCanvas";
import { ScoresCanvas } from "./canvases/ScoresCanvas";
import { toCanvasMode, type DetailMode } from "./types";

export type { DetailMode } from "./types";
export { TRACE_VIEWER_MODES } from "./types";

export interface TraceViewerProps {
  open: boolean;
  onClose: () => void;
  traceId: string;
  title?: React.ReactNode;
  outcome?: string | null;
  onPrev?: () => void;
  onNext?: () => void;
  highlightSpanId?: string | null;
  initialMode?: DetailMode;
  onModeChange?: (mode: DetailMode) => void;
  onSpanSelect?: (spanId: string | null) => void;
  onAnnotate?: () => void;
  onShare?: () => void;
  className?: string;
}

/**
 * Purpose-built fullscreen trace viewer — sole public entry.
 * Unified top bar · always-on span nav · mode canvas · optional inspector.
 */
export function TraceViewer({
  open,
  onClose,
  traceId,
  title,
  outcome: outcomeProp,
  onPrev,
  onNext,
  highlightSpanId,
  initialMode = "transcript",
  onModeChange,
  onSpanSelect,
  onAnnotate,
  onShare,
  className,
}: TraceViewerProps) {
  const [mode, setMode] = React.useState<DetailMode>(initialMode);
  const [ganttStripOpen, setGanttStripOpen] = React.useState(false);
  const [spanSearch, setSpanSearch] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const readerRef = React.useRef<HTMLDivElement | null>(null);
  const searchParams = useSearchParams();
  const linkPreserve = React.useMemo(
    () => preserveFromSearchParams(searchParams),
    [searchParams],
  );

  React.useEffect(() => {
    setMode(initialMode);
  }, [initialMode, traceId]);

  // ?mode=tree → Transcript + focus span nav search
  React.useEffect(() => {
    if (!open) return;
    if (initialMode === "tree" || mode === "tree") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open, initialMode, mode, traceId]);

  const setModeAndNotify = (next: DetailMode) => {
    setMode(next);
    onModeChange?.(next);
  };

  const selection = useTraceViewerSelection({
    highlightSpanId,
    onSpanSelect,
    onRequestClose: onClose,
    open,
  });

  const canvasMode = toCanvasMode(mode);

  const data = useTraceViewerData({
    traceId,
    mode: canvasMode,
    ganttStripOpen,
  });

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      const meta = e.metaKey || e.ctrlKey;
      if ((meta && e.key === "f") || e.key === "/") {
        const target = e.target as HTMLElement | null;
        if (
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const inspectorVisible =
    selection.inspectorOpen &&
    selection.selectedSpanId != null &&
    (canvasMode === "transcript" || canvasMode === "timeline");

  const selectedRow = inspectorVisible
    ? findRowBySpanId(data.rows, selection.selectedSpanId) ??
      findRowBySpanId(data.treeRows, selection.selectedSpanId)
    : null;

  const failureOutcome =
    data.meta?.outcome === "failure" ||
    data.meta?.outcome === "error" ||
    data.meta?.outcome === "crash" ||
    data.meta?.outcome === "timeout"
      ? data.meta.outcome
      : null;

  const issuesHref = (() => {
    const q = new URLSearchParams();
    q.set("q", traceId);
    if (linkPreserve?.pastHours) q.set("pastHours", linkPreserve.pastHours);
    if (linkPreserve?.realm) q.set("realm", linkPreserve.realm);
    if (linkPreserve?.outcome) q.set("outcome", linkPreserve.outcome);
    if (linkPreserve?.agent_id) q.set("agent_id", linkPreserve.agent_id);
    return `/issues?${q.toString()}`;
  })();

  const chromeOutcome = outcomeProp ?? data.meta?.outcome ?? null;
  const spanNavRoots = data.treeRows.length > 0 ? data.treeRows : data.rows;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (selection.inspectorOpen) {
            selection.closeInspector();
            return;
          }
          onClose();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-[var(--bg-base)]/50 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
          data-testid="trace-viewer-backdrop"
        />
        <DialogPrimitive.Content
          data-testid="trace-viewer"
          data-testid-legacy="trace-viewer-modal"
          aria-modal="true"
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg outline-none",
            "inset-0 h-dvh max-h-dvh w-full rounded-none p-0",
            "sm:inset-2 sm:h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-1rem)] sm:rounded-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "duration-200",
            className,
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(e) => {
            if (selection.inspectorOpen) {
              e.preventDefault();
            }
          }}
        >
          {data.phase === "loading" ? (
            <>
              <UnifiedTopBar
                traceId={traceId}
                title={title}
                outcome={chromeOutcome}
                onClose={onClose}
                onPrev={onPrev}
                onNext={onNext}
                mode={mode}
                onModeChange={setModeAndNotify}
                meta={null}
                selectedSpanId={selection.selectedSpanId}
                onAnnotate={onAnnotate}
                onShare={onShare}
              />
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
                <p className="text-xs text-[var(--text-muted)]">Loading trace summary…</p>
              </div>
            </>
          ) : data.phase === "error" || data.phase === "not_found" ? (
            <>
              <UnifiedTopBar
                traceId={traceId}
                title={title}
                outcome={chromeOutcome}
                onClose={onClose}
                onPrev={onPrev}
                onNext={onNext}
                mode={mode}
                onModeChange={setModeAndNotify}
                meta={null}
                selectedSpanId={selection.selectedSpanId}
                onAnnotate={onAnnotate}
                onShare={onShare}
              />
              <ErrorState
                title="Could not load trace"
                message={data.error ?? "Unknown error"}
              />
            </>
          ) : (
            <>
              <UnifiedTopBar
                traceId={traceId}
                title={title}
                outcome={chromeOutcome}
                onClose={onClose}
                onPrev={onPrev}
                onNext={onNext}
                mode={mode}
                onModeChange={setModeAndNotify}
                meta={data.meta}
                totalTokens={data.totalTokens}
                selectedSpanId={selection.selectedSpanId}
                onAnnotate={onAnnotate}
                onShare={onShare}
                ganttStripOpen={ganttStripOpen}
                onToggleGantt={() => setGanttStripOpen((v) => !v)}
                liveSlot={
                  <TraceViewerLiveSlot
                    live={data.liveStream.live}
                    failed={data.liveStream.failed}
                    finalized={data.liveStream.finalized}
                    eventCount={data.liveStream.events.length}
                    onRetry={() => data.liveStream.retry()}
                  />
                }
              />

              <div
                className="relative flex min-h-0 flex-1 overflow-hidden"
                data-testid="trace-viewer-body"
              >
                {/* Span nav — always on (~26%) */}
                <div className="flex min-h-0 w-[26%] min-w-[160px] max-w-[320px] shrink-0">
                  <SpanNavTree
                    roots={spanNavRoots}
                    selectedSpanId={selection.selectedSpanId}
                    onSpanSelect={(id) => selection.selectSpan(id)}
                    searchQuery={spanSearch}
                    onSearchQueryChange={setSpanSearch}
                    searchInputRef={searchInputRef}
                  />
                </div>

                {/* Center canvas */}
                <div
                  className={cn(
                    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-space-3",
                    inspectorVisible && "xl:max-w-[none]",
                  )}
                  data-testid="trace-viewer-reader"
                >
                  {canvasMode === "scores" ? (
                    data.orgId ? (
                      <ScoresCanvas orgId={data.orgId} traceId={traceId} />
                    ) : (
                      <ErrorState
                        title="Organization required"
                        message="Select an organization to view judge scores for this trace."
                      />
                    )
                  ) : canvasMode === "timeline" ? (
                    <TimelineCanvas
                      loading={
                        data.timelineQuery.isLoading && data.timelineSteps.length === 0
                      }
                      error={data.timelineQuery.error?.message ?? null}
                      steps={data.timelineSteps}
                      totalMs={data.timelineTotalMs}
                      markers={data.timelineQuery.data?.markers ?? []}
                      selectedSpanId={selection.selectedSpanId}
                      onSpanSelect={(id) => selection.selectSpan(id)}
                    />
                  ) : canvasMode === "meta" ? (
                    <MetadataCanvas
                      traceId={traceId}
                      meta={data.meta}
                      sessionId={data.sessionId}
                      totalTokens={data.totalTokens}
                      rows={data.rows}
                    />
                  ) : (
                    <TranscriptCanvas
                      rows={data.rows}
                      selectedSpanId={selection.selectedSpanId}
                      onSelectSpan={(id) => selection.selectSpan(id)}
                      spanSearch={spanSearch}
                      ganttStripOpen={ganttStripOpen}
                      onToggleGantt={() => setGanttStripOpen((v) => !v)}
                      timelineSteps={data.timelineSteps}
                      timelineTotalMs={data.timelineTotalMs}
                      timelineLoading={data.timelineQuery.isLoading}
                      timelineError={data.timelineQuery.error?.message ?? null}
                      timelineMarkers={data.timelineQuery.data?.markers ?? []}
                      failureOutcome={failureOutcome}
                      issuesHref={issuesHref}
                      liveWaiting={data.liveStream.live}
                      readerRef={readerRef}
                    />
                  )}
                </div>

                {inspectorVisible && selectedRow ? (
                  <div
                    className={cn(
                      "flex min-h-0 shrink-0",
                      "absolute inset-0 z-20 xl:static xl:inset-auto xl:z-auto",
                      "w-full xl:w-[30%] xl:min-w-[360px] xl:max-w-[28rem]",
                    )}
                  >
                    <div
                      className="absolute inset-0 bg-[var(--bg-base)]/40 xl:hidden"
                      aria-hidden
                      onClick={() => selection.closeInspector()}
                    />
                    <SpanInspector
                      row={selectedRow}
                      traceId={traceId}
                      orgId={data.orgId}
                      onClose={() => selection.closeInspector()}
                      className="relative z-10 ml-auto h-full w-full max-w-[28rem] shadow-lg xl:shadow-none"
                    />
                  </div>
                ) : null}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
