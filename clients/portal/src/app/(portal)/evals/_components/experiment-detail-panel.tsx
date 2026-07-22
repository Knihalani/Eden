"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/format";
import type { ExperimentsTabState } from "../_hooks/use-experiments-tab";
import { ExperimentComparePanel } from "./experiment-compare-panel";

export type ExperimentDetailPanelProps = {
  open: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  canMutate: boolean;
  tab: ExperimentsTabState;
  mobileDrawer?: boolean;
};

export function ExperimentDetailPanel({
  open,
  onClose,
  onPrev,
  onNext,
  canMutate,
  tab,
  mobileDrawer = true,
}: ExperimentDetailPanelProps) {
  const t = useTranslations("evals");
  const { selected, listQuery, compareQuery } = tab;

  const title = selected?.name ?? t("experiments.detail.panelTitle");

  let body: ReactNode;
  if (listQuery.isLoading && !selected) {
    body = (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  } else if (!selected) {
    body = (
      <div className="p-4 text-sm text-[var(--text-muted)]">
        {t("experiments.detail.selectPrompt")}
      </div>
    );
  } else {
    body = (
      <div className="space-y-4 p-4" data-testid="experiment-detail-body">
        <div className="space-y-1">
          <p className="m-0 text-xs text-[var(--text-muted)]">
            {t("experiments.col.status")}: {selected.status}
            {" · "}
            {selected.created_at
              ? formatRelativeTime(selected.created_at)
              : "—"}
          </p>
          <p className="m-0 font-mono text-xs text-[var(--text-secondary)]">
            {t("experiments.col.dataset")}: {selected.dataset_id || "—"}
          </p>
        </div>

        {compareQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : compareQuery.error ? (
          <Panel tone="flat" padding="md" role="alert">
            <p className="m-0 text-sm text-[var(--text-secondary)]">
              {t("experiments.compare.loadError")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2 min-h-11"
              onClick={() => void compareQuery.refetch()}
            >
              {t("common.retry")}
            </Button>
          </Panel>
        ) : (
          <ExperimentComparePanel tab={tab} canMutate={canMutate} />
        )}
      </div>
    );
  }

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={title}
      onPrev={onPrev}
      onNext={onNext}
      mobileDrawer={mobileDrawer}
    >
      {body}
    </DetailPanelShell>
  );
}
