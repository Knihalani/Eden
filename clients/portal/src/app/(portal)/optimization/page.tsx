"use client";

/**
 * Wave 9.7 — Cost one page + modes.
 * Primary: Cost · Budget · Outcomes · Advisor.
 * Predict satellites (forecast/drift/spend/capacity/risk) live in Advanced overflow.
 */

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, Loader2 } from "lucide-react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrg } from "@/hooks/use-org";
import { useQueryTab } from "@/hooks/use-query-tab";
import { cn } from "@/lib/utils";

/** Wave 9 exit marker — Cost flattened to primary modes + Advanced predict. */
const WAVE9_COST_COMPLETED = true as const;
/** Wave 7 Improve V3 — Cost KPI strip + Advisor compare + nested header flatten. */
const WAVE7_IMPROVE_COST_COMPLETED = true as const;

const PRIMARY_TABS = ["cost", "budget", "outcomes", "advisor"] as const;
const ADVANCED_TABS = ["forecast", "drift", "spend", "capacity", "risk"] as const;
const COST_TABS = [...PRIMARY_TABS, ...ADVANCED_TABS] as const;

type CostTab = (typeof COST_TABS)[number];

const TAB_META: Record<CostTab, { label: string }> = {
  cost: { label: "Cost" },
  budget: { label: "Budget" },
  outcomes: { label: "Outcomes" },
  advisor: { label: "Model Advisor" },
  forecast: { label: "Forecast" },
  drift: { label: "Drift" },
  spend: { label: "Spend" },
  capacity: { label: "Capacity" },
  risk: { label: "Risk" },
};

function TabLoading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

const OutcomesPage = dynamic(() => import("./outcomes/page"), {
  ssr: false,
  loading: TabLoading,
});
const BudgetPage = dynamic(() => import("./budget/page"), {
  ssr: false,
  loading: TabLoading,
});
const FinOpsExplorer = dynamic(() => import("./_components/finops-explorer"), {
  ssr: false,
  loading: TabLoading,
});
const AdvisorPage = dynamic(() => import("./model-advisor/page"), {
  ssr: false,
  loading: TabLoading,
});

const PredictForecast = dynamic(
  () =>
    import("./_components/predict-panels").then((m) => ({
      default: m.PredictForecastPanel,
    })),
  { ssr: false, loading: TabLoading },
);
const PredictDrift = dynamic(
  () =>
    import("./_components/predict-panels").then((m) => ({
      default: m.PredictDriftPanel,
    })),
  { ssr: false, loading: TabLoading },
);
const PredictSpend = dynamic(
  () =>
    import("./_components/predict-panels").then((m) => ({
      default: m.PredictSpendPanel,
    })),
  { ssr: false, loading: TabLoading },
);
const PredictCapacity = dynamic(
  () =>
    import("./_components/predict-panels").then((m) => ({
      default: m.PredictCapacityPanel,
    })),
  { ssr: false, loading: TabLoading },
);
const PredictRisk = dynamic(
  () =>
    import("./_components/predict-panels").then((m) => ({
      default: m.PredictRiskPanel,
    })),
  { ssr: false, loading: TabLoading },
);

function isAdvancedTab(tab: CostTab): boolean {
  return (ADVANCED_TABS as readonly string[]).includes(tab);
}

function OptimizationPageInner() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useQueryTab("tab", COST_TABS, "cost");
  const advancedActive = isAdvancedTab(tab);

  if (!currentOrg) {
    return <NoOrgState feature="Cost & usage optimization" />;
  }

  return (
    <PageContent size="wide">
      <span
        className="sr-only"
        data-wave9-cost="completed"
        data-wave10-cost="flat"
        data-wave7-improve-cost={WAVE7_IMPROVE_COST_COMPLETED ? "completed" : undefined}
      >
        Cost flat modes
      </span>
      <PageHeader
        eyebrow="Improve"
        title="Cost"
        subtitle="Spend, budgets, outcomes, and model advice."
        description="Where your tokens go, what caching saves, and how the budget is burning."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as CostTab)}>
        <div
          data-testid="cost-toolbar"
          className="mb-space-4 flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-1"
        >
          <TabsList
            variant="underline"
            aria-label="Cost primary sections"
            className="h-auto min-w-0 flex-1 justify-start gap-1 overflow-x-auto bg-transparent"
          >
            {PRIMARY_TABS.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                variant="underline"
                className="min-h-11 shrink-0"
              >
                {TAB_META[t].label}
              </TabsTrigger>
            ))}
          </TabsList>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={advancedActive ? "outline" : "ghost"}
                className={cn(
                  "min-h-11 shrink-0",
                  advancedActive && "border-[var(--accent)] text-[var(--accent)]",
                )}
                aria-label="Advanced cost tools"
                aria-current={advancedActive ? "page" : undefined}
                data-testid="cost-advanced"
              >
                <span className="hidden sm:inline">
                  {advancedActive ? `Advanced · ${TAB_META[tab].label}` : "Advanced"}
                </span>
                <span className="sm:hidden">More</span>
                <ChevronDown className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuLabel>Predict</DropdownMenuLabel>
              {ADVANCED_TABS.map((t) => (
                <DropdownMenuItem
                  key={t}
                  onSelect={() => setTab(t)}
                  className={cn(tab === t && "bg-[var(--accent-bg)] text-[var(--accent)]")}
                >
                  {TAB_META[t].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <>
          {tab === "cost" && (
            <TabsContent value="cost" forceMount>
              <EmbeddedSurface>
                <FinOpsExplorer />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "budget" && (
            <TabsContent value="budget" forceMount>
              <EmbeddedSurface>
                <BudgetPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "outcomes" && (
            <TabsContent value="outcomes" forceMount>
              <EmbeddedSurface>
                <OutcomesPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "advisor" && (
            <TabsContent value="advisor" forceMount>
              <EmbeddedSurface>
                <AdvisorPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "forecast" && (
            <TabsContent value="forecast" forceMount>
              <EmbeddedSurface>
                <PredictForecast />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "drift" && (
            <TabsContent value="drift" forceMount>
              <EmbeddedSurface>
                <PredictDrift />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "spend" && (
            <TabsContent value="spend" forceMount>
              <EmbeddedSurface>
                <PredictSpend />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "capacity" && (
            <TabsContent value="capacity" forceMount>
              <EmbeddedSurface>
                <PredictCapacity />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "risk" && (
            <TabsContent value="risk" forceMount>
              <EmbeddedSurface>
                <PredictRisk />
              </EmbeddedSurface>
            </TabsContent>
          )}
        </>
      </Tabs>
    </PageContent>
  );
}

export default function OptimizationPage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <OptimizationPageInner />
    </Suspense>
  );
}
