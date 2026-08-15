"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { ERROR_STATE_ATTR } from "@/lib/overlay-defer";
import {
  featureGatedErrorCopy,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";

/**
 * Distinguishes HTTP failures from empty success lists.
 * Never use this for ``data === []`` — that is EmptyState territory.
 *
 * Marks ``<html data-eden-error-state>`` so the product tour defers
 * while a blocking error panel is on screen (observer watches html attrs).
 *
 * 501 / not_implemented and other feature-gated failures use honest
 * "Not available yet" copy instead of a generic outage message.
 */
export function QueryErrorPanel({
  title = "Couldn’t load data",
  error,
  onRetry,
}: {
  title?: string;
  error: Error | null | undefined;
  onRetry?: () => void;
}) {
  const rateLimited =
    error != null &&
    ((typeof error === "object" &&
      "status" in error &&
      (error as { status?: unknown }).status === 429) ||
      /too many requests|rate\s*limit/i.test(error.message || ""));
  const gated = error && !rateLimited ? featureGatedErrorCopy(error, title) : null;
  const displayTitle = rateLimited
    ? "Slow down — rate limited"
    : (gated?.title ?? title);
  const message = rateLimited
    ? "Eden briefly paused requests for this workspace. Wait a few seconds, then retry."
    : gated?.message?.trim() ||
      error?.message?.trim() ||
      "Something went wrong talking to the API. Try again.";
  const showRetry =
    Boolean(onRetry) &&
    error != null &&
    (rateLimited || isRetryableIntelligenceError(error));

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute(ERROR_STATE_ATTR, "1");
    return () => {
      root.removeAttribute(ERROR_STATE_ATTR);
    };
  }, []);

  return (
    <div
      className="flex min-h-[12rem] flex-1 flex-col items-center justify-center gap-3 px-5 text-center"
      role="alert"
    >
      <AlertTriangle
        className="h-5 w-5 text-[var(--error)]"
        strokeWidth={1.6}
        aria-hidden
      />
      <p className="type-title text-[var(--text)]">{displayTitle}</p>
      <p className="type-meta max-w-md text-[var(--text-faint)]">{message}</p>
      {showRetry ? (
        <button
          type="button"
          className="ds-btn ds-btn-secondary ds-btn-sm"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

const SKELETON_ROWS = [0, 1, 2];

/**
 * Shared loading surface. Skeleton rows (not a spinner, not bare text) so
 * every page that waits on a query renders the same quiet placeholder as
 * the route-level `loading.tsx` shells — the block shapes say "content is
 * coming" instead of a flat string that reads as a stuck page.
 *
 * The label is kept for assistive tech (announced via `role="status"`)
 * and is intentionally sr-only — a visible "Loading traces…" would
 * duplicate the skeleton it labels.
 */
export function QueryLoadingPanel({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex min-h-[12rem] flex-1 flex-col items-center justify-center gap-4 px-5"
      role="status"
      aria-label={label}
    >
      <div className="w-full max-w-md space-y-2">
        <div className="eden-skeleton-pulse h-3.5 w-1/3 rounded bg-[var(--line)]" />
        {SKELETON_ROWS.map((i) => (
          <div
            key={i}
            className="eden-skeleton-pulse flex items-center gap-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3.5"
          >
            <div className="h-4 w-10 shrink-0 rounded bg-[var(--line)]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3.5 w-1/3 rounded bg-[var(--line)]" />
              <div className="h-3 w-1/2 rounded bg-[var(--line)]" />
            </div>
            <div className="h-3 w-12 shrink-0 rounded bg-[var(--line)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Compact skeleton block for `next/dynamic` loading fallbacks — the
 * lazy chunk import is near-instant, so this is deliberately lighter
 * than `QueryLoadingPanel` (one title bar + a few rows, no hero block).
 * Same skeleton vocabulary as the route-level shells.
 */
export function LoadingFallback({
  label = "Loading…",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div
      className="flex min-h-[12rem] flex-1 flex-col gap-3 px-5 py-6"
      role="status"
      aria-label={label}
    >
      <div className="eden-skeleton-pulse h-3.5 w-32 rounded bg-[var(--line)]" />
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="eden-skeleton-pulse h-9 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)]"
        />
      ))}
    </div>
  );
}

/**
 * Inline pulsing bar for PageHeader `meta` slots while queries stream in —
 * the header keeps its layout, and the loader speaks the same skeleton
 * language as `LoadingFallback`. The label is sr-only so assistive tech
 * hears it while the visual reads as a quiet placeholder bar.
 */
export function InlineLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-1.5 align-middle">
      <span className="sr-only">{label}</span>
      <span className="eden-skeleton-pulse inline-block h-3 w-20 rounded bg-[var(--line)]" />
    </span>
  );
}
