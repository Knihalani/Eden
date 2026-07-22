"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import {
  EVALS_ADVANCED_TABS,
  EVALS_PRIMARY_TABS,
  isEvalsAdvancedTab,
  type EvalsTab,
} from "@/lib/evals-url";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEvalsUrlState } from "./_hooks/use-evals-url-state";
import { EvalsHubToolbar } from "./_components/evals-hub-toolbar";
import { DatasetsTab } from "./_components/datasets-tab";
import { PlaygroundsTab } from "./_components/playgrounds-tab";
import { ExperimentsTab } from "./_components/experiments-tab";
import { LabelingTab } from "./_components/labeling-tab";
import { StudioTab } from "./_components/studio-tab";
import { SyntheticTab } from "./_components/synthetic-tab";
import { EvalScoresTab } from "./_components/eval-scores-tab";

function EvalsPageInner() {
  const t = useTranslations("evals");
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");
  const { state, setState, clearSelection } = useEvalsUrlState();
  const tab = state.tab;
  const q = state.q ?? "";

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
        clearSelection();
        return;
      }

      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < EVALS_PRIMARY_TABS.length) {
        e.preventDefault();
        setState({ tab: EVALS_PRIMARY_TABS[idx] });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clearSelection, setState]);

  function setTab(next: EvalsTab) {
    setState({ tab: next });
  }

  function setSearch(value: string) {
    setState({ q: value || undefined });
  }

  const advancedActive = isEvalsAdvancedTab(tab);
  const primaryValue = advancedActive ? "" : tab;

  const tabProps = { canMutate };

  let panel: ReactNode = null;
  switch (tab) {
    case "datasets":
      panel = <DatasetsTab {...tabProps} />;
      break;
    case "playgrounds":
      panel = <PlaygroundsTab {...tabProps} />;
      break;
    case "experiments":
      panel = <ExperimentsTab {...tabProps} />;
      break;
    case "labeling":
      panel = <LabelingTab {...tabProps} />;
      break;
    case "studio":
      panel = <StudioTab {...tabProps} />;
      break;
    case "synthetic":
      panel = <SyntheticTab {...tabProps} />;
      break;
    case "eval":
      panel = <EvalScoresTab {...tabProps} />;
      break;
    default:
      panel = <DatasetsTab {...tabProps} />;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4" data-testid="evals-page">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="evals-tabs-chrome"
      >
        <Tabs
          value={primaryValue}
          onValueChange={(v) => setTab(v as EvalsTab)}
        >
          <TabsList variant="underline" aria-label={t("tabsAria")}>
            {EVALS_PRIMARY_TABS.map((id) => (
              <TabsTrigger
                key={id}
                variant="underline"
                value={id}
                className="min-h-11"
                data-testid={`evals-tab-${id}`}
              >
                {t(`tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant={advancedActive ? "secondary" : "ghost"}
              className="min-h-11"
              data-testid="evals-advanced-tabs"
              aria-label={t("tabs.advanced")}
            >
              {advancedActive ? t(`tabs.${tab}`) : t("tabs.advanced")}
              <ChevronDown className="ml-1 h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            <DropdownMenuLabel>{t("tabs.advanced")}</DropdownMenuLabel>
            {EVALS_ADVANCED_TABS.map((id) => (
              <DropdownMenuItem
                key={id}
                onSelect={() => setTab(id)}
                data-testid={`evals-advanced-${id}`}
              >
                {t(`tabs.${id}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <EvalsHubToolbar
        q={q}
        filter={state.filter}
        agentId={state.agentId}
        onSearchChange={setSearch}
      />

      <div data-testid={`evals-panel-${tab}`}>{panel}</div>

      <nav
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-3 text-sm"
        aria-label={t("related.aria")}
        data-testid="evals-related-strip"
      >
        <span className="text-[var(--text-muted)]">{t("related.label")}</span>
        <Link
          href="/issues"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.issues")}
        </Link>
        <Link
          href="/traces"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.traces")}
        </Link>
        <Link
          href="/improve"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.improve")}
        </Link>
        <Link
          href="/cost"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.cost")}
        </Link>
      </nav>
    </div>
  );
}

export default function EvalsPage() {
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
      <EvalsPageInner />
    </Suspense>
  );
}
