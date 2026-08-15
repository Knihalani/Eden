"use client";

import { useId } from "react";
import { X } from "lucide-react";

export function RevertPlanDialog({
  planTitle,
  prUrl,
  busy = false,
  onCancel,
  onConfirm,
}: {
  planTitle: string;
  prUrl?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const titleId = useId();

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={busy ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <h2 id={titleId} className="type-ui text-[var(--text)]">
            Revert merged fix
          </h2>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onCancel}
            aria-label="Close"
            disabled={busy}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          <p className="type-meta truncate" title={planTitle}>
            {planTitle}
          </p>
          <p className="type-body text-[var(--text-secondary)]">
            Eden drafts an inverse-diff revert plan, statically checks it
            against current HEAD, then opens a revert PR. This records a
            reverted outcome on the original merge.
          </p>
          {prUrl ? (
            <p className="type-meta break-all">Original PR: {prUrl}</p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm !text-[var(--error)]"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? "Reverting…" : "Revert"}
          </button>
        </footer>
      </div>
    </div>
  );
}
