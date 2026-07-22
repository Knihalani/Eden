"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Database } from "lucide-react";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/format";
import { useDatasetsTab, type DatasetListRow } from "../_hooks/use-datasets-tab";
import { DatasetDetailPanel } from "./dataset-detail-panel";

export type DatasetsTabProps = {
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

export function DatasetsTab({ canMutate }: DatasetsTabProps) {
  const t = useTranslations("evals");
  const d = useDatasetsTab();
  const isXl = useIsXl();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const columns: DataTableColumn<DatasetListRow>[] = [
    {
      key: "name",
      header: t("datasets.col.name"),
      sortable: true,
      cell: (row) => (
        <span className="font-medium text-[var(--text-primary)]">{row.name}</span>
      ),
    },
    {
      key: "row_count",
      header: t("datasets.col.cases"),
      align: "right",
      sortable: true,
      cell: (row) => String(row.row_count ?? 0),
    },
    {
      key: "updated",
      header: t("datasets.col.updated"),
      cell: (row) => {
        const ts = row.updated_at ?? row.created_at;
        return (
          <span title={ts ? new Date(ts).toISOString() : undefined}>
            {ts ? formatRelativeTime(ts) : "—"}
          </span>
        );
      },
    },
    {
      key: "source",
      header: t("datasets.col.source"),
      cell: (row) => row.source ?? "manual",
    },
  ];

  const detailOpen = Boolean(d.datasetId);

  async function handleCreate() {
    if (!newName.trim()) return;
    await d.createMutation.mutateAsync({ name: newName.trim() });
    setNewName("");
    setCreateOpen(false);
  }

  return (
    <div data-testid="evals-datasets-tab">
      <ResourcePageShell
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={d.state.q ?? ""}
              onChange={(e) => d.setSearch(e.target.value)}
              placeholder={t("datasets.searchPlaceholder")}
              className="max-w-xs"
              aria-label={t("datasets.searchPlaceholder")}
            />
            {canMutate ? (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                onClick={() => setCreateOpen(true)}
                data-testid="datasets-new"
              >
                {t("datasets.new")}
              </Button>
            ) : null}
          </div>
        }
        table={
          <QueryState
            loading={d.listQuery.isLoading}
            error={d.listQuery.error}
            data={d.filtered}
            onRetry={() => void d.listQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            filtersActive={d.filtersActive}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={Database}
                title={t("datasets.empty.title")}
                description={t("datasets.empty.body")}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" className="min-h-11">
                      <Link href="/traces">{t("datasets.empty.fromTraces")}</Link>
                    </Button>
                    {canMutate ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="min-h-11"
                        onClick={() => setCreateOpen(true)}
                      >
                        {t("datasets.new")}
                      </Button>
                    ) : null}
                  </div>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                icon={Database}
                title={t("datasets.filterEmpty.title")}
                description={t("datasets.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={d.clearFilters}
                  >
                    {t("datasets.filterEmpty.clear")}
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
                highlightRowId={d.datasetId}
                onRowClick={(row) => d.selectDataset(row.id)}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl && d.datasetId ? (
            <DatasetDetailPanel
              datasetId={d.datasetId}
              listRow={d.selected}
              open
              onClose={d.clearDatasetSelection}
              onPrev={d.selectedIndex > 0 ? d.selectPrev : undefined}
              onNext={
                d.selectedIndex >= 0 && d.selectedIndex < d.filtered.length - 1
                  ? d.selectNext
                  : undefined
              }
              canMutate={canMutate}
            />
          ) : undefined
        }
      />

      {detailOpen && !isXl && d.datasetId ? (
        <DatasetDetailPanel
          datasetId={d.datasetId}
          listRow={d.selected}
          open
          onClose={d.clearDatasetSelection}
          canMutate={canMutate}
          mobileDrawer
        />
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("datasets.createTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("datasets.namePlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!newName.trim() || d.createMutation.isPending}
              loading={d.createMutation.isPending}
              onClick={() => void handleCreate()}
            >
              {t("datasets.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
