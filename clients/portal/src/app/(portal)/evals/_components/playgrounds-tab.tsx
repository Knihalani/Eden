"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical } from "lucide-react";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { formatRelativeTime } from "@/lib/format";
import type { PersistedPlayground } from "@/lib/api";
import { usePlaygroundsTab } from "../_hooks/use-playgrounds-tab";
import { PlaygroundDetailPanel } from "./playground-detail-panel";

export type PlaygroundsTabProps = {
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

export function PlaygroundsTab({ canMutate }: PlaygroundsTabProps) {
  const t = useTranslations("evals");
  const p = usePlaygroundsTab();
  const isXl = useIsXl();

  const columns: DataTableColumn<PersistedPlayground>[] = [
    {
      key: "name",
      header: t("playgrounds.col.name"),
      sortable: true,
      cell: (row) => (
        <span className="font-medium text-[var(--text-primary)]">{row.name}</span>
      ),
    },
    {
      key: "model",
      header: t("playgrounds.col.model"),
      cell: (row) => {
        const tasks = Array.isArray(row.config?.tasks) ? row.config.tasks : [];
        const task0 =
          tasks[0] && typeof tasks[0] === "object"
            ? (tasks[0] as Record<string, unknown>)
            : {};
        return String(task0.model ?? row.config?.model ?? "—");
      },
    },
    {
      key: "updated_at",
      header: t("playgrounds.col.updated"),
      cell: (row) => {
        const ts = row.updated_at ?? row.created_at;
        return ts ? formatRelativeTime(ts) : "—";
      },
    },
  ];

  const detailOpen = Boolean(p.playgroundId);

  return (
    <div data-testid="evals-playgrounds-tab">
      <ResourcePageShell
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            {canMutate ? (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                loading={p.createMutation.isPending}
                onClick={() => void p.createMutation.mutateAsync()}
                data-testid="playgrounds-new"
              >
                {t("playgrounds.new")}
              </Button>
            ) : null}
          </div>
        }
        table={
          <QueryState
            loading={p.listQuery.isLoading}
            error={p.listQuery.error}
            data={p.playgrounds}
            onRetry={() => void p.listQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={FlaskConical}
                title={t("playgrounds.empty.title")}
                description={t("playgrounds.empty.body")}
                action={
                  canMutate ? (
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-11"
                      onClick={() => void p.createMutation.mutateAsync()}
                    >
                      {t("playgrounds.new")}
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {(rows) => (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                highlightRowId={p.playgroundId}
                onRowClick={(row) => p.selectPlayground(row.id)}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl && p.playgroundId ? (
            <PlaygroundDetailPanel
              open
              onClose={p.clearPlaygroundSelection}
              canMutate={canMutate}
              tab={p}
            />
          ) : undefined
        }
      />

      {detailOpen && !isXl ? (
        <PlaygroundDetailPanel
          open
          onClose={p.clearPlaygroundSelection}
          canMutate={canMutate}
          tab={p}
          mobileDrawer
        />
      ) : null}
    </div>
  );
}
