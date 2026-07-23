"use client";

import { useEffect } from "react";
import { ERROR_STATE_ATTR } from "@/lib/overlay-defer";

/**
 * Distinguishes HTTP failures from empty success lists.
 * Never use this for ``data === []`` — that is EmptyState territory.
 *
 * Marks ``<html data-eden-error-state>`` so the product tour defers
 * while a blocking error panel is on screen (observer watches html attrs).
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
  const message =
    error?.message?.trim() ||
    "Something went wrong talking to the API. Try again.";

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
      <p className="type-title text-[var(--text)]">{title}</p>
      <p className="type-meta max-w-md text-[var(--text-faint)]">{message}</p>
      {onRetry ? (
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

export function QueryLoadingPanel({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
      <p className="type-meta text-[var(--text-faint)]">{label}</p>
    </div>
  );
}
