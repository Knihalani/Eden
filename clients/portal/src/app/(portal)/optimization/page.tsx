"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useQueryTab } from "@/hooks/use-query-tab";

const COST_TABS = ["cost", "budget", "outcomes", "predict", "advisor"] as const;

/* ----------------------- Sub-pages (lazy) ----------------------------- */

const OutcomesPage = dynamic(() => import("./outcomes/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });
const PredictPage = dynamic(() => import("./predict/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });
const BudgetPage = dynamic(() => import("./budget/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });
const FinOpsExplorer = dynamic(
  () => import("./_components/finops-explorer"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    ),
  },
);
const AdvisorPage = dynamic(() => import("./model-advisor/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });

/* ----------------------- Page ---------------------------------------- */

function OptimizationPageInner() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useQueryTab("tab", COST_TABS, "cost");

  if (!currentOrg) {
    return <NoOrgState feature="Cost & usage optimization" />;
  }

  return (
    <PageContent size="wide">
      <PageHeader
        title="Cost"
        subtitle="Spend, budgets, outcomes, forecasts, and model advice."
        description="Where your tokens go, what caching saves, and how the budget is burning."
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as (typeof COST_TABS)[number])}
      >
        <TabsList variant="underline" className="w-full justify-start">
          <TabsTrigger value="cost" variant="underline">Cost</TabsTrigger>
          <TabsTrigger value="budget" variant="underline">Budget</TabsTrigger>
          <TabsTrigger value="outcomes" variant="underline">Outcomes</TabsTrigger>
          <TabsTrigger value="predict" variant="underline">Predict</TabsTrigger>
          <TabsTrigger value="advisor" variant="underline">Model Advisor</TabsTrigger>
        </TabsList>

        <>
          {tab === "cost" && (
            <TabsContent value="cost" forceMount={tab === "cost" ? true : undefined}>
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
          {tab === "predict" && (
            <TabsContent value="predict" forceMount>
              <EmbeddedSurface>
                <PredictPage />
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
        </>
      </Tabs>
    </PageContent>
  );
}

export default function OptimizationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <OptimizationPageInner />
    </Suspense>
  );
}
