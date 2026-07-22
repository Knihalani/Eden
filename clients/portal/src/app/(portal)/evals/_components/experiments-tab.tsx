"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Beaker } from "lucide-react";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { formatRelativeTime } from "@/lib/format";
import {
  useExperimentsTab,
  type ExperimentRow,
} from "../_hooks/use-experiments-tab";
import { ExperimentDetailPanel } from "./experiment-detail-panel";

export type ExperimentsTabProps = {
  canMutate: boolean;
};

function useIsXl() {
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setIsXl(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isXl;
}

export function ExperimentsTab({ canMutate }: ExperimentsTabProps) {
  const t = useTranslations("evals");
  const e = useExperimentsTab();
  const isXl = useIsXl();

  const columns: DataTableColumn<ExperimentRow>[] = [
    {
      key: "name",
      header: t("experiments.col.name"),
      sortable: true,
      cell: (row) => (
        <span className="font-medium text-[var(--text-primary)]">{row.name}</span>
      ),
    },
    {
      key: "dataset_id",
      header: t("experiments.col.dataset"),
      cell: (row) => (
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {row.dataset_id || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: t("experiments.col.status"),
      cell: (row) => row.status,
    },
    {
      key: "created_at",
      header: t("experiments.col.created"),
      sortable: true,
      cell: (row) =>
        row.created_at ? formatRelativeTime(row.created_at) : "—",
    },
  ];

  const detailOpen = Boolean(e.experimentId);

  return (
    <div data-testid="evals-experiments-tab">
      <ResourcePageShell
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={e.state.q ?? ""}
              onChange={(ev) => e.setSearch(ev.target.value)}
              placeholder={t("experiments.searchPlaceholder")}
              className="max-w-xs"
              aria-label={t("experiments.searchPlaceholder")}
            />
          </div>
        }
        table={
          <QueryState
            loading={e.listQuery.isLoading}
            error={e.listQuery.error}
            data={e.filtered}
            onRetry={() => void e.listQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            filtersActive={e.filtersActive}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={Beaker}
                title={t("experiments.empty.title")}
                description={t("experiments.empty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11"
                    onClick={() => e.setState({ tab: "datasets" })}
                  >
                    {t("experiments.empty.cta")}
                  </Button>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                icon={Beaker}
                title={t("experiments.filterEmpty.title")}
                description={t("experiments.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={e.clearFilters}
                  >
                    {t("experiments.filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(rows) => (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                highlightRowId={e.experimentId}
                onRowClick={(row) => e.selectExperiment(row.id)}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl ? (
            <ExperimentDetailPanel
              open
              onClose={e.clearExperimentSelection}
              onPrev={e.selectedIndex > 0 ? e.selectPrev : undefined}
              onNext={
                e.selectedIndex >= 0 && e.selectedIndex < e.filtered.length - 1
                  ? e.selectNext
                  : undefined
              }
              canMutate={canMutate}
              tab={e}
            />
          ) : undefined
        }
      />

      {detailOpen && !isXl ? (
        <ExperimentDetailPanel
          open
          onClose={e.clearExperimentSelection}
          canMutate={canMutate}
          tab={e}
          mobileDrawer
        />
      ) : null}
    </div>
  );
}
