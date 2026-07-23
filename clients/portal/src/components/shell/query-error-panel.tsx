"use client";

/**
 * Distinguishes HTTP failures from empty success lists.
 * Never use this for ``data === []`` — that is EmptyState territory.
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
