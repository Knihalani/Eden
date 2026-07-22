"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Radio, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  artifactHref,
  improveHref,
  labelingQueueHref,
  playgroundHref,
  preserveFromSearchParams,
  promoteTraceToDatasetHref,
  sessionHref,
} from "@/lib/portal-cross-links";
import { TRACE_VIEWER_MODES, type DetailMode } from "./types";
import type { TraceViewerMeta } from "./use-trace-viewer-data";

export interface TraceViewerToolbarProps {
  mode: DetailMode;
  onModeChange: (mode: DetailMode) => void;
  meta: TraceViewerMeta | null;
  totalTokens?: { input: number; output: number; total: number };
  traceId: string;
  selectedSpanId?: string | null;
  liveSlot?: React.ReactNode;
  spanSearch: string;
  onSpanSearchChange: (q: string) => void;
  onAnnotate?: () => void;
  onShare?: () => void;
  ganttStripOpen?: boolean;
  onToggleGantt?: () => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

const metricPill =
  "inline-flex items-center rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-space-2 py-space-1 font-mono text-2xs tabular-nums text-[var(--text-secondary)]";

/** Z1 toolbar (~36–40px): modes · metrics · search · Annotate/Share · More */
export function TraceViewerToolbar({
  mode,
  onModeChange,
  meta,
  totalTokens,
  traceId,
  selectedSpanId,
  liveSlot,
  spanSearch,
  onSpanSearchChange,
  onAnnotate,
  onShare,
  ganttStripOpen,
  onToggleGantt,
  searchInputRef,
}: TraceViewerToolbarProps) {
  const searchParams = useSearchParams();
  const linkPreserve = React.useMemo(
    () => preserveFromSearchParams(searchParams),
    [searchParams],
  );

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

  return (
    <div
      className="flex h-10 shrink-0 flex-wrap items-center gap-space-3 border-b border-[var(--border-default)] px-space-4 text-xs"
      data-testid="trace-viewer-toolbar"
      data-testid-legacy="trace-header"
    >
      <Tabs
        value={mode}
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
              className="min-h-8 px-2 text-xs"
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
        <span className={metricPill} data-metric="spans">
          {meta?.span_count ?? 0} spans
        </span>
        <span className={metricPill} data-metric="duration" data-pill="latency">
          {(meta?.duration_ms ?? 0).toFixed(0)}ms
        </span>
        <span className={metricPill} data-metric="cost" data-pill="cost">
          {meta?.cost_cents != null ? `$${(meta.cost_cents / 100).toFixed(2)}` : "—"}
        </span>
        <span className={metricPill} data-metric="tokens" data-pill="tokens">
          {totalTokens ? `${totalTokens.total.toLocaleString()} tok` : "—"}
        </span>
        <span className={metricPill} data-metric="model">
          {meta?.model ?? "—"}
        </span>
      </div>

      {liveSlot}

      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-0.5"
        data-testid="trace-span-search"
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <input
          ref={searchInputRef}
          type="search"
          value={spanSearch}
          onChange={(e) => onSpanSearchChange(e.target.value)}
          placeholder="Search spans… (/ or ⌘F)"
          aria-label="Search spans"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>

      <div
        className="flex flex-wrap items-center gap-space-1"
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
      </div>
    </div>
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
