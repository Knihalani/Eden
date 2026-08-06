"use client";

/**
 * Reject-plan reason prompt.
 *
 * ``POST /orgs/{org}/improve/plans/{id}/reject`` takes a free-text
 * ``reason`` (``RejectRequest.reason``, max 2000 chars). The backend
 * infers a dedupe bucket from it (``plans_repo._infer_rejection_type``):
 * a reason containing "user_fixed" / "already fixed" gets a 90-day
 * ``pr_rejection_memory`` TTL, "outdated" or anything else gets 30 days.
 * This dialog surfaces those three buckets as radio options so the
 * classification is deliberate rather than accidental substring luck,
 * plus an optional free-text detail appended after the category tag.
 */

import { useId, useState } from "react";
import { X } from "lucide-react";

export type RejectReasonCategory = "user_fixed" | "outdated" | "wontfix";

const REASON_OPTIONS: {
  value: RejectReasonCategory;
  label: string;
  hint: string;
}[] = [
  {
    value: "user_fixed",
    label: "Already fixed",
    hint: "Someone fixed this outside Eden — 90-day dedupe window.",
  },
  {
    value: "outdated",
    label: "Outdated",
    hint: "No longer applies — code has moved on.",
  },
  {
    value: "wontfix",
    label: "Won't fix",
    hint: "Not worth fixing right now — 30-day dedupe window.",
  },
];

export function RejectPlanDialog({
  planTitle,
  busy = false,
  onCancel,
  onConfirm,
}: {
  planTitle: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [category, setCategory] = useState<RejectReasonCategory>("wontfix");
  const [detail, setDetail] = useState("");
  const titleId = useId();

  const reason = detail.trim() ? `${category}: ${detail.trim()}` : category;

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
            Reject plan
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

        <div className="space-y-4 px-5 py-4">
          <p className="type-meta truncate" title={planTitle}>
            {planTitle}
          </p>

          <fieldset className="space-y-1.5">
            <legend className="type-label mb-1">Why is this rejected?</legend>
            {REASON_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-[var(--line)] px-3 py-2 has-[:checked]:border-[var(--accent)]"
              >
                <input
                  type="radio"
                  name="reject-reason-category"
                  value={opt.value}
                  checked={category === opt.value}
                  onChange={() => setCategory(opt.value)}
                  className="mt-0.5"
                />
                <span>
                  <span className="type-ui block">{opt.label}</span>
                  <span className="type-meta">{opt.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="block space-y-1.5">
            <span className="type-label">Details (optional)</span>
            <textarea
              className="ds-input min-h-[4.5rem] w-full"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              maxLength={1900}
              placeholder="Anything else worth recording…"
            />
          </label>
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
            onClick={() => void onConfirm(reason)}
            disabled={busy}
          >
            {busy ? "Rejecting…" : "Reject"}
          </button>
        </footer>
      </div>
    </div>
  );
}
