"use client";

import { useTranslations } from "next-intl";
import { Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Badge } from "@/components/ui/badge";
import { useLabelingTab } from "../_hooks/use-labeling-tab";
import { LabelingQueueBoard } from "./labeling-queue-board";

export type LabelingTabProps = {
  canMutate?: boolean;
};

export function LabelingTab({ canMutate = true }: LabelingTabProps) {
  const t = useTranslations("evals");
  const tab = useLabelingTab();

  if (tab.queueId) {
    return <LabelingQueueBoard canMutate={canMutate} />;
  }

  return (
    <div className="space-y-4" data-testid="evals-labeling-tab">
      <QueryState
        loading={tab.queuesQuery.isLoading}
        error={tab.queuesQuery.error}
        data={tab.queues}
        onRetry={() => void tab.queuesQuery.refetch()}
        isEmpty={(rows) => rows.length === 0}
        emptyKind="zero-data"
        emptySlot={
          <EmptyState
            icon={Columns3}
            title={t("labeling.emptyTitle")}
            description={t("labeling.emptyBody")}
            variant="plain"
          />
        }
      >
        {(queues) => (
          <DataTable
            rows={queues}
            rowKey={(q) => q.id}
            onRowClick={(q) => tab.openQueue(q.id)}
            emptyTitle={t("labeling.emptyTitle")}
            emptyDescription={t("labeling.emptyBody")}
            emptyIcon={Columns3}
            columns={[
              {
                key: "name",
                header: t("labeling.colName"),
                sortable: true,
                cell: (q) => (
                  <span className="font-medium text-[var(--text-primary)]">
                    {q.name || q.id}
                  </span>
                ),
              },
              {
                key: "description",
                header: t("labeling.colDescription"),
                cell: (q) => (
                  <span className="text-sm text-[var(--text-muted)]">
                    {q.description || "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: t("labeling.colStatus"),
                cell: (q) =>
                  q.status ? (
                    <Badge variant="secondary">{q.status}</Badge>
                  ) : (
                    <span className="text-[var(--text-muted)]">—</span>
                  ),
              },
              {
                key: "created_at",
                header: t("labeling.colCreated"),
                sortable: true,
                cell: (q) => (
                  <span className="text-xs text-[var(--text-muted)]">
                    {q.created_at
                      ? new Date(q.created_at).toLocaleString()
                      : "—"}
                  </span>
                ),
              },
              {
                key: "id",
                header: "",
                align: "right",
                cell: (q) => (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    onClick={(e) => {
                      e.stopPropagation();
                      tab.openQueue(q.id);
                    }}
                  >
                    {t("labeling.openBoard")}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </QueryState>
    </div>
  );
}
