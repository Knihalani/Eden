"use client";

import { useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { usePolling } from "@/hooks/use-polling";
import { Wallet, Loader2, AlertTriangle, CheckCircle2, History } from "lucide-react";

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
  const toast = useToast();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [consumption, setConsumption] = useState<Consumption | null>(null);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [actions, setActions] = useState<ActionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    if (!currentOrg?.id) return;
    try {
      const [b, a] = await Promise.all([
        fetch(`${API_BASE}/orgs/${currentOrg.id}/budget`, {
          credentials: "include",
        }),
        fetch(`${API_BASE}/orgs/${currentOrg.id}/budget/actions?limit=20`, {
          credentials: "include",
        }),
      ]);
      if (b.ok) {
        const data = await b.json();
        setBudget(data.data.budget);
        setConsumption(data.data.consumption);
        setRollup(data.data.rollup);
      }
      if (a.ok) {
        const data = await a.json();
        setActions(data.data.actions || []);
      }
    } catch (err) {
      toast.error(
        "Budget fetch failed",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  // PQ-1 fix: replace the raw ``setInterval`` (which kept firing
  // on background tabs and didn't back off on auth errors) with
  // ``usePolling``. Idle-tab pause + exponential backoff are now
  // the hook's job. The 5_000 ms cadence is preserved.
  usePolling({
    fetch: fetchData,
    intervalMs: 5_000,
    deps: [currentOrg?.id],
    enabled: Boolean(currentOrg?.id),
  });

  const handleSave = useCallback(async () => {
    if (!currentOrg?.id || !budget) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/orgs/${currentOrg.id}/budget`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cost_soft_limit_usd: budget.cost_soft_limit_usd,
          cost_hard_limit_usd: budget.cost_hard_limit_usd,
          enforcement_enabled: budget.enforcement_enabled,
          window: budget.window,
          action_on_exceed: budget.action_on_exceed,
          threshold_alert_pct: budget.threshold_alert_pct,
        }),
      });
      if (res.ok) {
        toast.success("Budget saved", "Cost guardrails updated.");
        await fetchData();
      } else {
        toast.error("Save failed", `HTTP ${res.status}. Org owner required.`);
      }
    } catch (err) {
      toast.error("Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }, [currentOrg?.id, budget, toast, fetchData]);

  if (!currentOrg) return <NoOrgState feature="Budgets" />;
  if (loading) {
    return (
      <div className="flex items-center justify-center p-12" role="status" aria-live="polite">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--text-secondary)]" />
      </div>
    );
  }

  const status = rollup?.exceeded
    ? "exceeded"
    : rollup?.alert_breached
    ? "alert"
    : "ok";

  return (
    <div className="space-y-6">
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
            Polls every 5s. Auto-refresh on this tab.
          </p>
        </div>
        <div className="divide-y divide-[var(--border-default)]">
          {actions.length === 0 ? (
            <EmptyState
              icon={History}
              title="No threshold events yet"
              description="Your cost is below the alert threshold. Events appear here once enforcement kicks in."
              size="sm"
              className="py-10"
            />
          ) : (
            actions.map((a) => (
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
    </div>
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