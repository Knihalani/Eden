"use client";

import { useState, useCallback, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageLoadingSkeleton } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Wallet, Loader2, AlertTriangle, CheckCircle2, History } from "lucide-react";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  featureGatedErrorCopy,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";

interface Budget {
  window: string;
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
  enforcement_enabled: boolean;
  action_on_exceed: string;
  threshold_alert_pct: number;
  source: string;
}

interface Consumption {
  window: string;
  cost_usd: number;
  requests_count: number;
  window_start?: string;
}

interface Rollup {
  cost_used_usd: number;
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
  pct_of_hard: number;
  threshold_alert_pct: number;
  alert_breached: boolean;
  exceeded: boolean;
}

interface ActionLog {
  id: string;
  action_type: string;
  severity: string;
  cost_at_action: number;
  threshold_pct: number;
  action_taken: string;
  created_at: string;
}

export default function BudgetPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [saving, setSaving] = useState(false);

  const {
    data: budgetData,
    isLoading,
    error: budgetError,
    refetch: refetchBudget,
  } = useOrgQuery(
    queryKeys.budget.detail(orgId),
    orgId,
    async () => {
      const res = await api.getBudget(orgId!);
      return res.data as { budget: Budget; consumption: Consumption; rollup: Rollup };
    },
    // PQ-1: React Query refetchInterval (pauses when tab hidden).
    // P5: ≥30s — dual 5s polls were burning budget endpoints.
    { refetchInterval: 30_000 },
  );
  const { data: actions, refetch: refetchActions } = useOrgQuery(
    queryKeys.budget.actions(orgId),
    orgId,
    async () => {
      const res = await api.getBudgetActions(orgId!, 20);
      return (res.data.actions ?? []) as ActionLog[];
    },
    // P5 consolidate: budget/detail keeps the 30s poll; action log
    // loads once + on save refetch — avoid dual 30s on this page.
  );
  const consumption = budgetData?.consumption ?? null;
  const rollup = budgetData?.rollup ?? null;

  // Keep an editable local copy of the budget config, resynced whenever
  // the server value changes (matches the previous polling behavior).
  useEffect(() => {
    if (budgetData?.budget) setBudget(budgetData.budget);
  }, [budgetData?.budget]);

  const handleSave = useCallback(async () => {
    if (!orgId || !budget) return;
    setSaving(true);
    try {
      await api.upsertBudget(orgId, {
        cost_soft_limit_usd: budget.cost_soft_limit_usd,
        cost_hard_limit_usd: budget.cost_hard_limit_usd,
        enforcement_enabled: budget.enforcement_enabled,
        window: budget.window,
        action_on_exceed: budget.action_on_exceed,
        threshold_alert_pct: budget.threshold_alert_pct,
      });
      toast.success("Budget saved", "Cost guardrails updated.");
      await Promise.all([refetchBudget(), refetchActions()]);
    } catch (err) {
      const detail =
        err instanceof ApiError ? `${err.message}. Org owner required.` : errorFromCaught(err, "Unknown error");
      toast.error("Save failed", detail);
    } finally {
      setSaving(false);
    }
  }, [orgId, budget, toast, refetchBudget, refetchActions]);

  if (!currentOrg) return <NoOrgState feature="Budgets" />;
  if (isLoading) {
    return <PageLoadingSkeleton variant="default" lines={4} />;
  }
  if (budgetError) {
    const copy = featureGatedErrorCopy(budgetError, "Could not load budget");
    return (
      <PageContent>
        <PageHeader eyebrow="Optimize" icon={Wallet} title="Cost Guardrails" />
        <ErrorState
          title={copy.title}
          message={copy.message}
          action={
            isRetryableIntelligenceError(budgetError) ? (
              <button
                onClick={() => refetchBudget()}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                Try again
              </button>
            ) : undefined
          }
        />
      </PageContent>
    );
  }

  const status = rollup?.exceeded
    ? "exceeded"
    : rollup?.alert_breached
    ? "alert"
    : "ok";

  return (
    <PageContent>
      <PageHeader
        eyebrow="Optimize"
        icon={Wallet}
        title="Cost Guardrails"
        subtitle="Per-org budget caps with closed-loop enforcement (D.10)"
      />

      {rollup && (
        <div
          className={cn(
            "rounded-lg border p-4",
            status === "exceeded"
              ? "border-[var(--error)]/40 bg-[var(--error-dim)]"
              : status === "alert"
              ? "border-[var(--warning)]/40 bg-[var(--warning-bg)]"
              : "border-[var(--border-default)] bg-[var(--bg-primary)]"
          )}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                This {budget?.window}
              </div>
              <div className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">
                ${rollup.cost_used_usd.toFixed(2)}
                <span className="ml-2 text-sm font-normal text-[var(--text-secondary)]">
                  / ${rollup.cost_hard_limit_usd.toFixed(2)} hard cap
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status === "exceeded" ? (
                <AlertTriangle className="h-5 w-5 text-[var(--error)]" />
              ) : status === "alert" ? (
                <AlertTriangle className="h-5 w-5 text-[var(--warning)]" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-[var(--terminal)]" />
              )}
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {rollup.pct_of_hard.toFixed(1)}% of hard cap
              </span>
            </div>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--bg-secondary)]">
            <div
              className={cn(
                "h-full transition-all",
                status === "exceeded"
                  ? "bg-[var(--error)]"
                  : status === "alert"
                  ? "bg-[var(--warning)]"
                  : "bg-[var(--terminal)]"
              )}
              style={{ width: `${Math.min(100, rollup.pct_of_hard)}%` }}
            />
          </div>
          {consumption && (
            <div className="mt-3 text-xs text-[var(--text-secondary)]">
              {consumption.requests_count.toLocaleString()} requests ·{" "}
              {budget?.source === "defaults" ? "free-tier defaults" : "custom config"}
            </div>
          )}
        </div>
      )}

      {budget && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-6">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text-primary)]">
            Budget config
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Soft limit (USD)"
              value={budget.cost_soft_limit_usd}
              onChange={(v) =>
                setBudget({ ...budget, cost_soft_limit_usd: v })
              }
              step={0.05}
              disabled={saving}
            />
            <Field
              label="Hard limit (USD)"
              value={budget.cost_hard_limit_usd}
              onChange={(v) =>
                setBudget({ ...budget, cost_hard_limit_usd: v })
              }
              step={0.05}
              disabled={saving}
            />
            <Select
              label="Window"
              value={budget.window}
              onChange={(v) => setBudget({ ...budget, window: v })}
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" },
              ]}
              disabled={saving}
            />
            <Select
              label="Action on exceed"
              value={budget.action_on_exceed}
              onChange={(v) =>
                setBudget({ ...budget, action_on_exceed: v })
              }
              options={[
                { value: "alert", label: "Alert only" },
                { value: "throttle", label: "Throttle (HTTP 429)" },
                { value: "kill", label: "Kill (HTTP 429 + closed-loop hook)" },
              ]}
              disabled={saving}
            />
            <Field
              label="Threshold alert %"
              value={budget.threshold_alert_pct}
              onChange={(v) =>
                setBudget({ ...budget, threshold_alert_pct: Math.round(v) })
              }
              step={1}
              disabled={saving}
            />
            <Checkbox
              label="Enforcement enabled"
              checked={budget.enforcement_enabled}
              onChange={(v) =>
                setBudget({ ...budget, enforcement_enabled: v })
              }
              help="When off, the cap is advisory only (existing customers default)."
              disabled={saving}
            />
          </div>
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              aria-label="Save budget configuration"
              className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Save (org owner only)
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
        <div className="border-b border-[var(--border-default)] p-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Recent threshold events
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Polls every 30s. Auto-refresh on this tab.
          </p>
        </div>
        <div className="divide-y divide-[var(--border-default)]">
          {(actions ?? []).length === 0 ? (
            <EmptyState
              icon={History}
              title="No threshold events yet"
              description="Your cost is below the alert threshold. Events appear here once enforcement kicks in."
              size="sm"
              className="py-10"
            />
          ) : (
            (actions ?? []).map((a) => (
              <div key={a.id} className="flex items-center justify-between p-3">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    {a.action_type}
                    <span
                      className={cn(
                        "ml-2 rounded px-1.5 py-0.5 text-xs",
                        a.severity === "high"
                          ? "bg-[var(--error-dim)] text-[var(--error)]"
                          : a.severity === "medium"
                          ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                          : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                      )}
                    >
                      {a.severity}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    {new Date(a.created_at).toLocaleString()} · ${a.cost_at_action.toFixed(2)} ({a.threshold_pct}% threshold)
                  </div>
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  action: {a.action_taken}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </PageContent>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <input
        type="number"
        value={value}
        step={step || 0.01}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        aria-label={label}
        disabled={disabled}
        className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 disabled:opacity-60"
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        disabled={disabled}
        className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  help,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-[var(--border-default)] disabled:opacity-60"
      />
      <div>
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {label}
        </div>
        {help && (
          <div className="mt-1 text-xs text-[var(--text-secondary)]">{help}</div>
        )}
      </div>
    </label>
  );
}