"use client";

/**
 * Budget config form — ``POST /orgs/{org_id}/budget``
 * (``UpsertBudgetRequest`` in ``eden/api/routes/budgets.py``).
 *
 * Org-owner gated server-side (``require_org_owner``); the page decides
 * whether to render the "Edit budget" entry point based on permissions,
 * this dialog just collects + validates the form and hands the typed
 * payload back to the caller, mirroring ``RejectPlanDialog``.
 */

import { useId, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type BudgetWindow = "daily" | "weekly" | "monthly";
export type BudgetActionOnExceed = "throttle" | "kill" | "alert";

export type BudgetFormValues = {
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
  enforcement_enabled: boolean;
  window: BudgetWindow;
  action_on_exceed: BudgetActionOnExceed;
  /** 50/80/100 crossing points — fan out to in-app + email alerts. */
  alert_thresholds: number[];
};

const WINDOW_OPTIONS: { value: BudgetWindow; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const ACTION_OPTIONS: {
  value: BudgetActionOnExceed;
  label: string;
  hint: string;
}[] = [
  {
    value: "alert",
    label: "Alert only",
    hint: "Notify the org — never blocks or slows requests.",
  },
  {
    value: "throttle",
    label: "Throttle",
    hint: "Slow down requests once the hard limit is hit.",
  },
  {
    value: "kill",
    label: "Kill",
    hint: "Reject new requests once the hard limit is hit.",
  },
];

const THRESHOLD_OPTIONS = [50, 80, 100];

export function EditBudgetDialog({
  initial,
  busy = false,
  error = null,
  onCancel,
  onSave,
}: {
  initial: BudgetFormValues;
  busy?: boolean;
  /** Server-side error surfaced by the caller (e.g. a failed save). */
  error?: string | null;
  onCancel: () => void;
  onSave: (values: BudgetFormValues) => void | Promise<void>;
}) {
  const titleId = useId();
  const [softLimit, setSoftLimit] = useState(
    String(initial.cost_soft_limit_usd),
  );
  const [hardLimit, setHardLimit] = useState(
    String(initial.cost_hard_limit_usd),
  );
  const [enforcementEnabled, setEnforcementEnabled] = useState(
    initial.enforcement_enabled,
  );
  const [windowValue, setWindowValue] = useState<BudgetWindow>(
    initial.window,
  );
  const [actionOnExceed, setActionOnExceed] = useState<BudgetActionOnExceed>(
    initial.action_on_exceed,
  );
  const [thresholds, setThresholds] = useState<number[]>(
    initial.alert_thresholds.length > 0
      ? initial.alert_thresholds
      : [50, 80, 100],
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const toggleThreshold = (t: number) => {
    setThresholds((prev) =>
      prev.includes(t)
        ? prev.filter((x) => x !== t)
        : [...prev, t].sort((a, b) => a - b),
    );
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const soft = Number(softLimit);
    const hard = Number(hardLimit);
    if (!Number.isFinite(soft) || soft < 0) {
      setLocalError("Enter a valid non-negative soft limit.");
      return;
    }
    if (!Number.isFinite(hard) || hard < 0) {
      setLocalError("Enter a valid non-negative hard limit.");
      return;
    }
    if (hard < soft) {
      setLocalError("Hard limit must be greater than or equal to the soft limit.");
      return;
    }
    if (thresholds.length === 0) {
      setLocalError("Select at least one alert threshold.");
      return;
    }
    setLocalError(null);
    void onSave({
      cost_soft_limit_usd: soft,
      cost_hard_limit_usd: hard,
      enforcement_enabled: enforcementEnabled,
      window: windowValue,
      action_on_exceed: actionOnExceed,
      alert_thresholds: thresholds,
    });
  };

  const shownError = localError ?? error;

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
            Edit budget
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

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5">
                <span className="type-label">Soft limit (USD)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  className="ds-input w-full"
                  value={softLimit}
                  onChange={(e) => setSoftLimit(e.target.value)}
                  disabled={busy}
                  required
                />
              </label>
              <label className="block space-y-1.5">
                <span className="type-label">Hard limit (USD)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  className="ds-input w-full"
                  value={hardLimit}
                  onChange={(e) => setHardLimit(e.target.value)}
                  disabled={busy}
                  required
                />
              </label>
            </div>

            <label className="block space-y-1.5">
              <span className="type-label">Window</span>
              <select
                className="ds-input w-full"
                value={windowValue}
                onChange={(e) => setWindowValue(e.target.value as BudgetWindow)}
                disabled={busy}
              >
                {WINDOW_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="space-y-1.5">
              <legend className="type-label mb-1">
                Action when the hard limit is hit
              </legend>
              {ACTION_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-[var(--line)] px-3 py-2 has-[:checked]:border-[var(--accent)]"
                >
                  <input
                    type="radio"
                    name="action-on-exceed"
                    value={opt.value}
                    checked={actionOnExceed === opt.value}
                    onChange={() => setActionOnExceed(opt.value)}
                    disabled={busy}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="type-ui block">{opt.label}</span>
                    <span className="type-meta">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="type-label mb-1">Alert thresholds</legend>
              <div className="flex gap-2">
                {THRESHOLD_OPTIONS.map((t) => {
                  const checked = thresholds.includes(t);
                  return (
                    <label
                      key={t}
                      className={cn(
                        "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius)] border border-[var(--line)] px-3 py-2 transition-colors",
                        checked && "border-[var(--accent)] bg-[var(--accent-muted)]",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => toggleThreshold(t)}
                        disabled={busy}
                      />
                      <span className="type-ui">{t}%</span>
                    </label>
                  );
                })}
              </div>
              <p className="type-meta">
                Notifies (and emails at 100%) the org when spend crosses each
                selected threshold of the hard limit.
              </p>
            </fieldset>

            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={enforcementEnabled}
                onChange={(e) => setEnforcementEnabled(e.target.checked)}
                disabled={busy}
              />
              <span className="type-ui">Enforce this budget</span>
            </label>

            {shownError ? (
              <p className="type-meta text-[var(--error)]" role="alert">
                {shownError}
              </p>
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
              type="submit"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={busy}
            >
              {busy ? "Saving…" : "Save budget"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
