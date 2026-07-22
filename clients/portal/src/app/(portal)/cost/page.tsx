"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { COST_TABS, type CostTab } from "@/lib/cost-url";
import { usePermissions } from "@/hooks/use-permissions";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCostUrlState } from "./_hooks/use-cost-url-state";
import { CostHubToolbar } from "./_components/cost-hub-toolbar";
import { OverviewTab } from "./_components/overview-tab";
import { BudgetTab } from "./_components/budget-tab";
import { OutcomesTab } from "./_components/outcomes-tab";
import { ForecastTab } from "./_components/forecast-tab";
import { AdvisorTab } from "./_components/advisor-tab";

function CostPageInner() {
  const t = useTranslations("cost");
  const { role } = usePermissions();
  const canAdmin = role === "admin" || role === "owner";
  const canActAdvisor = role != null && role !== "viewer";
  const { state, setState, clearSelection } = useCostUrlState();
  const tab = state.tab;
  const q = state.q ?? "";
  const [budgetEditorOpen, setBudgetEditorOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (isFormField) return;

      if (e.key === "Escape") {
        e.preventDefault();
        setBudgetEditorOpen(false);
        clearSelection();
        return;
      }

      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        setState({ tab: "budget" });
        return;
      }

      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < COST_TABS.length) {
        e.preventDefault();
        setState({ tab: COST_TABS[idx] });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clearSelection, setState]);

  function setTab(next: CostTab) {
    setState({ tab: next });
  }

  let panel: ReactNode = null;
  switch (tab) {
    case "overview":
      panel = (
        <OverviewTab
          pastHours={state.pastHours}
          agentId={state.agentId}
          groupBy={state.groupBy}
          q={q}
          onGroupByChange={(groupBy) => setState({ groupBy })}
          onAgentIdChange={(agentId) => setState({ agentId })}
        />
      );
      break;
    case "budget":
      panel = (
        <BudgetTab
          canAdmin={canAdmin}
          agentId={state.agentId}
          budgetId={state.budgetId}
          onBudgetIdChange={(budgetId) => setState({ budgetId })}
          editorOpen={budgetEditorOpen}
          onEditorOpenChange={setBudgetEditorOpen}
        />
      );
      break;
    case "outcomes":
      panel = <OutcomesTab agentId={state.agentId} />;
      break;
    case "forecast":
      panel = (
        <ForecastTab pastHours={state.pastHours} agentId={state.agentId} />
      );
      break;
    case "advisor":
      panel = (
        <AdvisorTab
          pastHours={state.pastHours}
          agentId={state.agentId}
          model={state.model}
          canAct={canActAdvisor}
        />
      );
      break;
    default:
      panel = (
        <OverviewTab
          pastHours={state.pastHours}
          agentId={state.agentId}
          groupBy={state.groupBy}
          q={q}
          onGroupByChange={(groupBy) => setState({ groupBy })}
          onAgentIdChange={(agentId) => setState({ agentId })}
        />
      );
  }

  const createBudgetCta =
    canAdmin && (tab === "overview" || tab === "budget") ? (
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setTab("budget");
          setBudgetEditorOpen(true);
        }}
        data-testid="cost-create-budget"
      >
        {t("budget.create")}
      </Button>
    ) : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4" data-testid="cost-hub">
      <nav
        className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
        aria-label={t("breadcrumb.aria")}
        data-testid="cost-breadcrumb"
      >
        <span>{t("breadcrumb.improve")}</span>
        <span aria-hidden>/</span>
        <span className="text-[var(--text-secondary)]">
          {t("breadcrumb.cost")}
        </span>
      </nav>

      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={createBudgetCta}
      />

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="cost-tabs-chrome"
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as CostTab)}>
          <TabsList variant="underline" aria-label={t("tabsAria")}>
            {COST_TABS.map((id) => (
              <TabsTrigger
                key={id}
                variant="underline"
                value={id}
                className="min-h-11"
                data-testid={`cost-tab-${id}`}
              >
                {t(`tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <CostHubToolbar
        pastHours={state.pastHours}
        agentId={state.agentId}
        q={q}
        onPastHoursChange={(hours) => setState({ pastHours: hours })}
        onAgentIdChange={(agentId) => setState({ agentId })}
        onSearchChange={(value) => setState({ q: value || undefined })}
      />

      <div data-testid={`cost-panel-${tab}`}>{panel}</div>

      <nav
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-3 text-sm"
        aria-label={t("related.aria")}
        data-testid="cost-related-strip"
      >
        <span className="text-[var(--text-muted)]">{t("related.label")}</span>
        <Link
          href="/traces"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.traces")}
        </Link>
        <Link
          href="/agents"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.agents")}
        </Link>
        <Link
          href="/improve"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.improve")}
        </Link>
        <Link
          href="/evals"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.evals")}
        </Link>
      </nav>
    </div>
  );
}

export default function CostPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <CostPageInner />
    </Suspense>
  );
}
