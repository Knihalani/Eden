"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, History, Wallet } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorFromCaught } from "@/lib/safe-error-message";
import { fmtUsd } from "./cost-format";

type BudgetConfig = {
  window: string;
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
  enforcement_enabled: boolean;
  action_on_exceed: string;
  threshold_alert_pct: number;
  source: string;
};

type Rollup = {
  cost_used_usd: number;
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
  pct_of_hard: number;
  threshold_alert_pct: number;
  alert_breached: boolean;
  exceeded: boolean;
};

type ActionLog = {
  id: string;
  action_type: string;
  severity: string;
  cost_at_action: number;
  threshold_pct: number;
  action_taken: string;
  created_at: string;
};

type BudgetBundle = {
  budget: BudgetConfig;
  consumption: {
    window: string;
    cost_usd: number;
    requests_count: number;
  };
  rollup: Rollup;
  actions: ActionLog[];
};

type Props = {
  canAdmin: boolean;
  agentId?: string;
  budgetId?: string;
  onBudgetIdChange: (id: string | undefined) => void;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
};

export function BudgetTab({
  canAdmin,
  agentId,
  budgetId,
  onBudgetIdChange,
  editorOpen,
  onEditorOpenChange,
}: Props) {
  const t = useTranslations("cost");
  const toast = useToast();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const query = useOrgQuery(
    queryKeys.budget.detail(orgId),
    orgId,
    async (): Promise<BudgetBundle> => {
      const [budgetRes, actionsRes] = await Promise.all([
        api.getBudget(orgId!),
        api.getBudgetActions(orgId!, 20),
      ]);
      return {
        budget: budgetRes.data.budget as BudgetConfig,
        consumption: budgetRes.data.consumption,
        rollup: budgetRes.data.rollup as Rollup,
        actions: (actionsRes.data.actions ?? []) as ActionLog[],
      };
    },
    { refetchInterval: 30_000 },
  );

  useEffect(() => {
    if (query.data?.budget) setDraft(query.data.budget);
  }, [query.data?.budget]);

  useEffect(() => {
    if (query.data && !budgetId) onBudgetIdChange("org");
  }, [query.data, budgetId, onBudgetIdChange]);

  async function handleSave() {
    if (!orgId || !draft) return;
    setSaving(true);
    try {
      await api.upsertBudget(orgId, {
        cost_soft_limit_usd: draft.cost_soft_limit_usd,
        cost_hard_limit_usd: draft.cost_hard_limit_usd,
        enforcement_enabled: draft.enforcement_enabled,
        window: draft.window,
        action_on_exceed: draft.action_on_exceed,
        threshold_alert_pct: draft.threshold_alert_pct,
      });
      toast.success(t("budget.savedTitle"), t("budget.savedBody"));
      onEditorOpenChange(false);
      await query.refetch();
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? `${err.message}. ${t("budget.adminRequired")}`
          : errorFromCaught(err, t("budget.saveFailed"));
      toast.error(t("budget.saveFailed"), detail);
    } finally {
      setSaving(false);
    }
  }

  if (!currentOrg) return <NoOrgState feature={t("budget.title")} />;

  const alertsHref = agentId
    ? `/alerts?agentId=${encodeURIComponent(agentId)}`
    : "/alerts";
  const issuesHref = agentId
    ? `/issues?agentId=${encodeURIComponent(agentId)}`
    : "/issues";

  return (
    <>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
        errorTitle={t("errors.loadBudget")}
        isEmpty={() => false}
        loadingSlot={
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        }
        emptySlot={
          <EmptyState
            icon={Wallet}
            title={t("budget.emptyTitle")}
            description={t("budget.emptyBody")}
            action={
              canAdmin ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onEditorOpenChange(true)}
                >
                  {t("budget.create")}
                </Button>
              ) : undefined
            }
          />
        }
      >
        {(data) => {
          const { budget, rollup, consumption, actions } = data;
          const status = rollup.exceeded
            ? "failed"
            : rollup.alert_breached
              ? "human_review"
              : "completed";
          const statusKey = rollup.exceeded
            ? "exceeded"
            : rollup.alert_breached
              ? "alert"
              : "ok";
          const selected = budgetId === "org" || !budgetId;

          return (
            <div className="space-y-4" data-testid="cost-budget-panel">
              {(rollup.exceeded || rollup.alert_breached) && (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-sm"
                  data-testid="cost-budget-overage"
                >
                  <span className="flex items-center gap-2 text-[var(--warning)]">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                    {rollup.exceeded
                      ? t("budget.exceededBanner")
                      : t("budget.alertBanner")}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="secondary">
                      <Link href={alertsHref}>{t("budget.openAlerts")}</Link>
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={issuesHref}>{t("budget.openIssues")}</Link>
                    </Button>
                  </div>
                </div>
              )}

              <Panel tone="inset" padding="md">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="text-xs text-[var(--text-muted)]">
                      <tr>
                        <th className="pb-2 pr-3 font-medium">
                          {t("budget.colName")}
                        </th>
                        <th className="pb-2 pr-3 font-medium">
                          {t("budget.colScope")}
                        </th>
                        <th className="pb-2 pr-3 font-medium tabular-nums">
                          {t("budget.colLimit")}
                        </th>
                        <th className="pb-2 pr-3 font-medium tabular-nums">
                          {t("budget.colSpent")}
                        </th>
                        <th className="pb-2 pr-3 font-medium">
                          {t("budget.colPeriod")}
                        </th>
                        <th className="pb-2 font-medium">
                          {t("budget.colStatus")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        className={`cursor-pointer border-t border-[var(--border-subtle)] ${
                          selected ? "bg-[var(--accent-faint)]/40" : ""
                        }`}
                        onClick={() => onBudgetIdChange("org")}
                        data-testid="cost-budget-row"
                      >
                        <td className="py-2 pr-3 font-medium">
                          {t("budget.orgBudget")}
                        </td>
                        <td className="py-2 pr-3 text-[var(--text-secondary)]">
                          {t("budget.scopeOrg")}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmtUsd(budget.cost_hard_limit_usd)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmtUsd(rollup.cost_used_usd)}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {budget.window}
                        </td>
                        <td className="py-2">
                          <StatusBadge status={status} />
                          <span className="sr-only">
                            {t(`budget.status.${statusKey}`)}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Panel>

              {selected ? (
                <Panel
                  tone="inset"
                  padding="md"
                  data-testid="cost-budget-detail"
                >
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-[var(--text-primary)]">
                        {t("budget.detailTitle")}
                      </h3>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {t("budget.detailMeta", {
                          requests: consumption.requests_count,
                          soft: fmtUsd(budget.cost_soft_limit_usd),
                          pct: rollup.pct_of_hard.toFixed(0),
                        })}
                      </p>
                    </div>
                    {canAdmin ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onEditorOpenChange(true)}
                        data-testid="cost-budget-edit"
                      >
                        {t("budget.edit")}
                      </Button>
                    ) : null}
                  </div>

                  <div className="mb-4">
                    <div className="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
                      <span>{t("budget.burn")}</span>
                      <span className="tabular-nums">
                        {rollup.pct_of_hard.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded bg-[var(--bg-tertiary)]">
                      <div
                        className={`h-full rounded motion-reduce:transition-none transition-[width] duration-300 ${
                          rollup.exceeded
                            ? "bg-[var(--error)]"
                            : rollup.alert_breached
                              ? "bg-[var(--warning)]"
                              : "bg-[var(--terminal)]"
                        }`}
                        style={{
                          width: `${Math.min(100, Math.max(2, rollup.pct_of_hard))}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    {rollup.exceeded || rollup.alert_breached ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-[var(--warning)]" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 text-[var(--terminal)]" />
                    )}
                    {t("budget.threshold", {
                      pct: budget.threshold_alert_pct,
                    })}
                  </div>
                </Panel>
              ) : null}

              <Panel tone="inset" padding="md">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <History className="h-4 w-4" aria-hidden />
                  {t("budget.actionsTitle")}
                </h3>
                {actions.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)]">
                    {t("budget.noActions")}
                  </p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {actions.map((a) => (
                      <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-2 first:border-0 first:pt-0"
                      >
                        <span className="font-mono text-xs text-[var(--text-secondary)]">
                          {a.action_type} · {a.action_taken}
                        </span>
                        <span className="tabular-nums text-[var(--text-muted)]">
                          {fmtUsd(a.cost_at_action)} ·{" "}
                          {new Date(a.created_at).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          );
        }}
      </QueryState>

      <Dialog open={editorOpen} onOpenChange={onEditorOpenChange}>
        <DialogContent data-testid="cost-budget-editor">
          <DialogHeader>
            <DialogTitle>
              {draft ? t("budget.editTitle") : t("budget.createTitle")}
            </DialogTitle>
          </DialogHeader>
          {draft ? (
            <div className="space-y-3">
              <label className="block text-xs text-[var(--text-muted)]">
                {t("budget.softLimit")}
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  className="mt-1"
                  value={draft.cost_soft_limit_usd}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      cost_soft_limit_usd: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="block text-xs text-[var(--text-muted)]">
                {t("budget.hardLimit")}
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  className="mt-1"
                  value={draft.cost_hard_limit_usd}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      cost_hard_limit_usd: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="block text-xs text-[var(--text-muted)]">
                {t("budget.alertPct")}
                <Input
                  type="number"
                  step="1"
                  min={1}
                  max={100}
                  className="mt-1"
                  value={draft.threshold_alert_pct}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      threshold_alert_pct: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enforcement_enabled}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      enforcement_enabled: e.target.checked,
                    })
                  }
                />
                {t("budget.enforcement")}
              </label>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              {t("budget.loadingForm")}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onEditorOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!draft || saving || !canAdmin}
              loading={saving}
              onClick={() => void handleSave()}
            >
              {t("budget.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
