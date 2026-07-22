"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Radio,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { isFocusInTranscript } from "@/hooks/use-list-keyboard-nav";
import {
  artifactHref,
  improveHref,
  labelingQueueHref,
  playgroundHref,
  preserveFromSearchParams,
  promoteTraceToDatasetHref,
  sessionHref,
} from "@/lib/portal-cross-links";
import { cn } from "@/lib/utils";
import {
  TRACE_VIEWER_MODES,
  toCanvasMode,
  type DetailMode,
} from "./types";
import type { TraceViewerMeta } from "./use-trace-viewer-data";

export interface UnifiedTopBarProps {
  traceId: string;
  title?: React.ReactNode;
  outcome?: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  mode: DetailMode;
  onModeChange: (mode: DetailMode) => void;
  meta: TraceViewerMeta | null;
  totalTokens?: { input: number; output: number; total: number };
  selectedSpanId?: string | null;
  liveSlot?: React.ReactNode;
  onAnnotate?: () => void;
  onShare?: () => void;
  ganttStripOpen?: boolean;
  onToggleGantt?: () => void;
}

const metricPill =
  "inline-flex items-center rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-space-2 py-space-1 font-mono text-2xs tabular-nums text-[var(--text-secondary)]";

/** Single top bar: identity · modes · metrics · actions · close. */
export function UnifiedTopBar({
  traceId,
  title,
  outcome,
  onClose,
  onPrev,
  onNext,
  mode,
  onModeChange,
  meta,
  totalTokens,
  selectedSpanId,
  liveSlot,
  onAnnotate,
  onShare,
  ganttStripOpen,
  onToggleGantt,
}: UnifiedTopBarProps) {
  const [copied, setCopied] = React.useState(false);
  const searchParams = useSearchParams();
  const linkPreserve = React.useMemo(
    () => preserveFromSearchParams(searchParams),
    [searchParams],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      if (isFocusInTranscript()) return;
      if (e.key === "j" && onNext) {
        e.preventDefault();
        onNext();
      }
      if (e.key === "k" && onPrev) {
        e.preventDefault();
        onPrev();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onNext, onPrev]);

  const copyId = React.useCallback(() => {
    void navigator.clipboard.writeText(traceId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [traceId]);

  const spanForPlayground = selectedSpanId ?? undefined;
  const addToDatasetHref = promoteTraceToDatasetHref(traceId, linkPreserve);
  const openPlaygroundHref = playgroundHref(traceId, spanForPlayground, linkPreserve);
  const sessionId = meta?.session_id ?? null;

  const openInLinks = [
    { label: "Open Improve", href: improveHref() },
    { label: "Create artifact", href: artifactHref() },
    { label: "Seed labeling", href: labelingQueueHref() },
    { label: "Related issues", href: `/issues?q=${encodeURIComponent(traceId)}` },
    { label: "Alerts", href: "/alerts" },
  ];
  if (sessionId) {
    openInLinks.unshift({
      label: "Open session",
      href: sessionHref(sessionId, linkPreserve),
    });
  }

  const pillClass =
    "rounded border border-[var(--border-subtle)] px-space-1 py-space-1 font-mono text-[var(--text-muted)] tabular-nums";

  const tabValue = toCanvasMode(mode);

  return (
    <header
      className="flex shrink-0 flex-col gap-space-2 border-b border-[var(--border-default)] bg-[var(--bg-primary)] px-space-4 py-space-2 sm:flex-row sm:items-center sm:gap-space-3 sm:py-0 sm:h-14"
      data-testid="trace-viewer-topbar"
      data-testid-legacy="trace-viewer-chrome"
    >
      <div className="flex min-w-0 flex-1 items-center gap-space-2">
        {onPrev || onNext ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onPrev}
              disabled={!onPrev}
              aria-label="Previous trace"
              className={cn(
                "rounded p-space-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30",
                FOCUS_RING_CLASS,
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              aria-label="Next trace"
              className={cn(
                "rounded p-space-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30",
                FOCUS_RING_CLASS,
              )}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <TraceOutcomeBadge outcome={outcome ?? null} />
        <DialogPrimitive.Title className="min-w-0 truncate text-sm font-semibold text-[var(--text-primary)]">
          {title ?? <span className="font-mono">{traceId.slice(0, 20)}…</span>}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">
          Fullscreen trace viewer for {traceId}
        </DialogPrimitive.Description>
        <div className="hidden min-w-0 items-center gap-1 sm:flex">
          <span className="truncate font-mono text-2xs text-[var(--text-muted)]">
            {traceId}
          </span>
          <button
            type="button"
            onClick={copyId}
            aria-label="Copy trace id"
            data-testid="trace-viewer-copy-id"
            className={cn(
              "inline-flex min-h-8 min-w-8 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              FOCUS_RING_CLASS,
            )}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[var(--terminal)]" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      <Tabs
        value={tabValue}
        onValueChange={(id) => onModeChange(id as DetailMode)}
        className="w-full sm:w-auto"
      >
        <TabsList
          variant="underline"
          aria-label="Trace detail modes"
          className="h-auto gap-1 rounded-none bg-transparent p-0"
        >
          {TRACE_VIEWER_MODES.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              variant="underline"
              className="min-h-8 px-2 text-xs font-medium"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div
        className="flex flex-wrap items-center gap-space-2"
        data-testid="trace-header-metrics"
        data-metric-count={5}
      >
        <span className={metricPill} data-metric="duration" data-pill="latency">
          {(meta?.duration_ms ?? 0).toFixed(0)}ms
        </span>
        <span className={metricPill} data-metric="spans">
          {meta?.span_count ?? 0} spans
        </span>
        <span className={metricPill} data-metric="tokens" data-pill="tokens">
          {totalTokens ? `${totalTokens.total.toLocaleString()} tok` : "—"}
        </span>
        <span className={metricPill} data-metric="cost" data-pill="cost">
          {meta?.cost_cents != null ? `$${(meta.cost_cents / 100).toFixed(2)}` : "—"}
        </span>
        <span className={metricPill} data-metric="model">
          {meta?.model ?? "—"}
        </span>
      </div>

      {liveSlot}

      <div
        className="flex min-w-0 items-center gap-1.5"
        data-testid="trace-context-pills"
      >
        {sessionId ? (
          <span className={pillClass} data-pill="session">
            session {sessionId.slice(0, 10)}…
          </span>
        ) : null}
        {meta?.user_id ? (
          <span className={pillClass} data-pill="user">
            user {meta.user_id.slice(0, 12)}…
          </span>
        ) : null}
      </div>

      <div
        className="ml-auto flex flex-wrap items-center gap-1.5"
        data-wave-e1-trace-loop="primary"
        data-wave-v3-6-loop="secondary"
      >
        {onAnnotate ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={onAnnotate}
            data-testid="trace-annotate"
          >
            Annotate
          </Button>
        ) : null}
        {onShare ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={onShare}
            data-testid="trace-share"
          >
            Share
          </Button>
        ) : null}
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs font-medium text-[var(--text-secondary)]"
        >
          <Link
            href={addToDatasetHref}
            data-testid="trace-add-to-dataset"
            data-wave-e1-trace-cta="add-to-dataset"
            data-wave-v3-6-cta="add-to-dataset"
          >
            Add to dataset
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs font-medium text-[var(--text-secondary)]"
        >
          <Link
            href={openPlaygroundHref}
            data-testid="trace-open-playground"
            data-wave-e1-trace-cta="open-playground"
            data-wave-v3-6-cta="open-playground"
          >
            Iterate in playground
          </Link>
        </Button>
        <details className="group relative">
          <summary
            className="inline-flex cursor-pointer list-none items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden"
            data-testid="trace-actions-overflow"
          >
            More
            <ChevronRight className="h-3 w-3 opacity-60 transition-transform group-open:rotate-90" />
          </summary>
          <div className="absolute right-0 top-full z-20 mt-1 min-w-[11rem] rounded border border-[var(--border-default)] bg-[var(--bg-primary)] py-1 shadow-md">
            {onToggleGantt ? (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                onClick={onToggleGantt}
              >
                {ganttStripOpen ? "Hide Gantt strip" : "Show Gantt strip"}
              </button>
            ) : null}
            {openInLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                data-wave9-improve-crossloop={
                  link.label === "Open Improve" ? "trace-improve" : undefined
                }
                className="block px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </details>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close trace viewer (Esc)"
          data-testid="trace-viewer-close"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
            FOCUS_RING_CLASS,
          )}
        >
          <X className="h-3.5 w-3.5 sm:hidden" aria-hidden />
          <span className="hidden sm:inline">Close</span>
          <kbd
            className="hidden sm:inline-block rounded border border-[var(--border-subtle)] px-1 py-0.5 font-mono text-2xs text-[var(--text-muted)]"
            data-shortcut-chip="esc"
          >
            Esc
          </kbd>
        </button>
      </div>
    </header>
  );
}

export function TraceViewerLiveSlot({
  live,
  failed,
  finalized,
  eventCount,
  onRetry,
}: {
  live: boolean;
  failed: boolean;
  finalized: boolean;
  eventCount: number;
  onRetry: () => void;
}) {
  return (
    <>
      {live && !finalized && (
        <span
          data-testid="live-trace-badge"
          className="inline-flex items-center gap-1 rounded border border-[var(--terminal)]/40 bg-[var(--terminal)]/10 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--terminal)]"
          aria-live="polite"
        >
          <Radio className="h-3 w-3 animate-pulse" aria-hidden />
          Live
        </span>
      )}
      {failed && !finalized && (
        <button
          type="button"
          data-testid="live-trace-retry"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded border border-[var(--error)]/40 px-1.5 py-0.5 text-xs font-medium text-[var(--error)] hover:bg-[var(--error)]/10"
        >
          Live reconnect failed — Retry
        </button>
      )}
      {finalized && (
        <span className="text-xs text-[var(--text-muted)]">Live → persisted</span>
      )}
      {eventCount > 0 ? (
        <span className="text-xs text-[var(--text-muted)]">+{eventCount} live</span>
      ) : null}
    </>
  );
}
