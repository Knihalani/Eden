"use client";

import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSyntheticTab } from "../_hooks/use-synthetic-tab";

export type SyntheticTabProps = {
  canMutate?: boolean;
};

export function SyntheticTab({ canMutate = true }: SyntheticTabProps) {
  const t = useTranslations("evals");
  const syn = useSyntheticTab();

  return (
    <div className="space-y-4" data-testid="evals-synthetic-tab">
      <Panel tone="flat" padding="md" className="space-y-3">
        <p className="text-xs text-[var(--text-muted)]">
          {t("synthetic.generateHelp")}
        </p>
        <Textarea
          placeholder={t("synthetic.sourcePlaceholder")}
          value={syn.text}
          onChange={(e) => syn.setText(e.target.value)}
          className="min-h-[120px] font-mono text-sm"
          disabled={!canMutate || syn.generateMutation.isPending}
          aria-label={t("synthetic.sourceLabel")}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label
            className="whitespace-nowrap text-xs text-[var(--text-muted)]"
            htmlFor="qa-per-chunk"
          >
            {t("synthetic.qaPerChunk")}
          </label>
          <Input
            id="qa-per-chunk"
            type="number"
            min={1}
            max={20}
            value={syn.qaPerChunk}
            onChange={(e) =>
              syn.setQaPerChunk(
                Math.max(1, Math.min(20, Number(e.target.value) || 1)),
              )
            }
            className="h-8 w-24 max-md:min-h-11"
            disabled={!canMutate || syn.generateMutation.isPending}
          />
          {canMutate ? (
            <Button
              type="button"
              className="min-h-11 sm:ml-auto"
              disabled={!syn.text.trim()}
              loading={syn.generateMutation.isPending}
              onClick={() => syn.generate()}
            >
              {!syn.generateMutation.isPending ? (
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
              ) : null}
              {t("synthetic.generate")}
            </Button>
          ) : (
            <p className="text-xs text-[var(--text-muted)] sm:ml-auto">
              {t("viewerReadonly")}
            </p>
          )}
        </div>
      </Panel>

      {syn.lastResult ? (
        <Panel tone="flat" padding="none" className="overflow-hidden">
          <div className="border-b border-[var(--border-subtle)] px-4 py-2 text-xs text-[var(--text-muted)]">
            {t("synthetic.lastRun")}{" "}
            <span className="font-mono">{syn.lastResult.run_id}</span>
            {" · "}
            {syn.lastResult.triple_count} {t("synthetic.triples")} ·{" "}
            {syn.lastResult.qa_type} · {syn.lastResult.locale}
          </div>
          <DataTable
            rows={syn.triples}
            rowKey={(r) => r.id}
            selectable={canMutate}
            bulkActions={
              canMutate
                ? [
                    {
                      label: t("synthetic.addToDataset"),
                      onClick: (rows) => syn.openAddToDataset(rows),
                    },
                  ]
                : undefined
            }
            emptyTitle={t("synthetic.triplesEmptyTitle")}
            emptyDescription={t("synthetic.triplesEmptyBody")}
            emptyIcon={Sparkles}
            columns={[
              {
                key: "question",
                header: t("synthetic.colQuestion"),
                cell: (r) => <span className="text-sm">{r.question}</span>,
              },
              {
                key: "answer",
                header: t("synthetic.colAnswer"),
                cell: (r) => (
                  <span className="text-sm text-[var(--text-muted)]">
                    {r.answer}
                  </span>
                ),
              },
              {
                key: "difficulty",
                header: t("synthetic.colDifficulty"),
                align: "right",
                sortable: true,
              },
            ]}
          />
        </Panel>
      ) : null}

      <Panel
        tone="inset"
        padding="md"
        role="status"
        data-testid="synthetic-history-deferred"
      >
        <EmptyState
          icon={Sparkles}
          title={t("synthetic.historyDeferredTitle")}
          description={syn.historyDetail}
          variant="plain"
        />
      </Panel>

      <Dialog open={syn.addOpen} onOpenChange={syn.setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("synthetic.addToDataset")}</DialogTitle>
            <DialogDescription>
              {t("synthetic.addToDatasetBody", {
                count: syn.pendingTriples.length,
              })}
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              {t("synthetic.pickDataset")}
            </span>
            <Select
              value={syn.datasetId || undefined}
              onValueChange={syn.setDatasetId}
            >
              <SelectTrigger className="min-h-11">
                <SelectValue placeholder={t("synthetic.pickDataset")} />
              </SelectTrigger>
              <SelectContent>
                {syn.datasets.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => syn.setAddOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              loading={syn.addRowsMutation.isPending}
              onClick={() => syn.confirmAddToDataset()}
            >
              {t("synthetic.addToDataset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
