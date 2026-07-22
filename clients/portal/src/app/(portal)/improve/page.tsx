"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { usePermissions } from "@/hooks/use-permissions";
import { IMPROVE_TABS, type ImproveTab } from "@/lib/improve-url";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RelatedStrip } from "@/components/improve";
import { useImproveUrlState } from "./_hooks/use-improve-url-state";
import { ImproveHubToolbar } from "./_components/improve-hub-toolbar";
import { QueueTab } from "./_components/queue-tab";
import { PlansTab } from "./_components/plans-tab";
import { ArtifactsTab } from "./_components/artifacts-tab";
import { PromotionsTab } from "./_components/promotions-tab";
import { LedgerTab } from "./_components/ledger-tab";
import { HistoryTab } from "./_components/history-tab";
import { CreatePlanDialog } from "./_components/create-plan-dialog";

function ImprovePageInner() {
  const t = useTranslations("improve");
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");
  const { state, setState, clearSelection } = useImproveUrlState();
  const tab = state.tab;
  const q = state.q ?? "";
  const [createOpen, setCreateOpen] = useState(false);

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

      if (e.key === "n" && canMutate) {
        e.preventDefault();
        setCreateOpen(true);
        return;
      }

      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < IMPROVE_TABS.length) {
        e.preventDefault();
        setState({ tab: IMPROVE_TABS[idx] });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canMutate, clearSelection, setState]);

  function setTab(next: ImproveTab) {
    setState({ tab: next });
  }

  function setSearch(value: string) {
    setState({ q: value || undefined });
  }

  const tabProps = { canMutate };

  let panel: ReactNode = null;
  switch (tab) {
    case "queue":
      panel = <QueueTab {...tabProps} />;
      break;
    case "plans":
      panel = <PlansTab {...tabProps} />;
      break;
    case "artifacts":
      panel = <ArtifactsTab {...tabProps} />;
      break;
    case "promotions":
      panel = <PromotionsTab {...tabProps} />;
      break;
    case "ledger":
      panel = <LedgerTab />;
      break;
    case "history":
      panel = <HistoryTab {...tabProps} />;
      break;
    default:
      panel = <QueueTab {...tabProps} />;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4" data-testid="improve-hub">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {!canMutate ? (
        <p className="text-sm text-[var(--text-muted)]" data-testid="improve-viewer-note">
          {t("viewerReadonly")}
        </p>
      ) : null}

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="improve-tabs-chrome"
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as ImproveTab)}>
          <TabsList variant="underline" aria-label={t("tabsAria")}>
            {IMPROVE_TABS.map((id) => (
              <TabsTrigger
                key={id}
                variant="underline"
                value={id}
                className="min-h-11"
                data-testid={`improve-tab-${id}`}
              >
                {t(`tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <ImproveHubToolbar
        q={q}
        onSearchChange={setSearch}
        searchPlaceholder={t("searchPlaceholder")}
        showQueueViews={tab === "queue"}
        queueStatus={state.status ?? "needs_you"}
        onQueueStatusChange={(status) => setState({ status })}
        queueLabels={{
          needsYou: t("queue.views.needsYou"),
          inProgress: t("queue.views.inProgress"),
          verify: t("queue.views.verify"),
        }}
        primaryAction={
          canMutate ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              onClick={() => setCreateOpen(true)}
              data-testid="improve-new-plan"
            >
              {t("plans.new")}
            </Button>
          ) : null
        }
      />

      <div data-testid={`improve-panel-${tab}`}>{panel}</div>

      <RelatedStrip
        links={[
          { href: "/issues", label: t("related.issues") },
          { href: "/traces", label: t("related.traces") },
          { href: "/evals", label: t("related.evals") },
          { href: "/cost?tab=advisor", label: t("related.cost") },
        ]}
      />

      <CreatePlanDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export default function ImprovePage() {
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
      <ImprovePageInner />
    </Suspense>
  );
}
