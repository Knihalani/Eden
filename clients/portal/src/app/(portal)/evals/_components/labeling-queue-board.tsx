"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Database, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLabelingTab, type BoardItem } from "../_hooks/use-labeling-tab";

const HOTKEY_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type LabelingQueueBoardProps = {
  canMutate?: boolean;
};

function Column({
  title,
  items,
  activeId,
  onSelect,
}: {
  title: string;
  items: BoardItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Panel tone="inset" padding="sm" className="min-h-[10rem]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {title}
        </h3>
        <Badge variant="secondary">{items.length}</Badge>
      </div>
      <ul className="max-h-48 space-y-1 overflow-auto">
        {items.length === 0 ? (
          <li className="px-1 py-2 text-xs text-[var(--text-muted)]">—</li>
        ) : (
          items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-xs min-h-11 ${
                  item.id === activeId
                    ? "bg-[var(--accent-muted)] text-[var(--accent)]"
                    : "hover:bg-[var(--surface-raised)] text-[var(--text-secondary)]"
                }`}
                onClick={() => onSelect(item.id)}
              >
                {item.prompt || item.id}
              </button>
            </li>
          ))
        )}
      </ul>
    </Panel>
  );
}

export function LabelingQueueBoard({
  canMutate = true,
}: LabelingQueueBoardProps) {
  const t = useTranslations("evals");
  const q = useLabelingTab();
  const [showCheat, setShowCheat] = useState(true);

  const { labels, applyLabel, skipActive } = q;

  useEffect(() => {
    if (!canMutate) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "?") {
        setShowCheat((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && labels[0]) {
        e.preventDefault();
        applyLabel(labels[0]);
        return;
      }
      const idx = HOTKEY_LABELS.indexOf(
        e.key as (typeof HOTKEY_LABELS)[number],
      );
      if (idx >= 0 && labels[idx]) {
        e.preventDefault();
        applyLabel(labels[idx]);
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        skipActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyLabel, canMutate, labels, skipActive]);

  return (
    <div className="space-y-4" data-testid="evals-labeling-board">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => q.closeQueue()}
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t("labeling.back")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={() => setShowCheat((v) => !v)}
        >
          <Keyboard className="h-3.5 w-3.5" aria-hidden />
          {t("labeling.shortcuts")}
        </Button>
        {canMutate ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:ml-auto"
            onClick={() => q.setPushOpen(true)}
          >
            <Database className="h-3.5 w-3.5" aria-hidden />
            {t("labeling.pushToDataset")}
          </Button>
        ) : null}
      </div>

      <div className="border-y border-[var(--border-subtle)] py-2 text-xs text-[var(--text-secondary)]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-[var(--text-primary)]">
            {t("labeling.hotkeys")}
          </span>
          {q.labels.slice(0, 9).map((label, i) => (
            <span key={label}>
              <kbd className="rounded border border-[var(--border-subtle)] px-1">
                {i + 1}
              </kbd>{" "}
              {label}
            </span>
          ))}
          <span>
            <kbd className="rounded border border-[var(--border-subtle)] px-1">
              S
            </kbd>{" "}
            {t("labeling.skip")}
          </span>
        </div>
        {showCheat ? (
          <ul className="mt-2 list-inside list-disc space-y-0.5 text-[var(--text-muted)]">
            {q.labels.map((label, i) => (
              <li key={label}>
                <kbd>{i + 1}</kbd> → {label}
              </li>
            ))}
            <li>
              <kbd>S</kbd> {t("labeling.skip")}
            </li>
          </ul>
        ) : null}
      </div>

      <QueryState
        loading={q.boardQuery.isLoading}
        error={q.boardQuery.error}
        data={q.boardQuery.data ?? { board: {}, schema: {} }}
        onRetry={() => void q.boardQuery.refetch()}
        isEmpty={() => false}
      >
        {() => (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <Column
                title={t("labeling.colPending")}
                items={q.boardColumns.pending}
                activeId={q.active?.id ?? null}
                onSelect={q.setActiveId}
              />
              <Column
                title={t("labeling.colLabeled")}
                items={q.boardColumns.labeled}
                activeId={q.active?.id ?? null}
                onSelect={q.setActiveId}
              />
              <Column
                title={t("labeling.colSkipped")}
                items={q.boardColumns.skipped}
                activeId={q.active?.id ?? null}
                onSelect={q.setActiveId}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Panel tone="inset" padding="md">
                <h3 className="mb-2 text-sm font-medium">
                  {t("labeling.transcript")}
                </h3>
                {q.active ? (
                  <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-sm text-[var(--text-secondary)]">
                    {q.transcript || "(empty)"}
                  </pre>
                ) : (
                  <EmptyState
                    icon={Database}
                    title={t("labeling.queueEmptyTitle")}
                    description={t("labeling.queueEmptyBody")}
                    variant="plain"
                    size="sm"
                  />
                )}
              </Panel>

              <Panel tone="inset" padding="md" className="space-y-3">
                <h3 className="text-sm font-medium">{t("labeling.labelPanel")}</h3>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-[var(--text-muted)]">
                    {t("labeling.notes")}
                  </span>
                  <Textarea
                    value={q.notes}
                    onChange={(e) => q.setNotes(e.target.value)}
                    placeholder={t("labeling.notesPlaceholder")}
                    disabled={!canMutate || !q.active}
                    rows={3}
                  />
                </label>
                {canMutate ? (
                  <div className="flex flex-wrap gap-2">
                    {q.labels.map((label, i) => (
                      <Button
                        key={label}
                        type="button"
                        size="sm"
                        variant={i === 0 ? "default" : "outline"}
                        className="min-h-11"
                        disabled={!q.active || q.annotateMutation.isPending}
                        onClick={() => q.applyLabel(label)}
                      >
                        <span className="mr-1 text-[var(--text-muted)]">
                          {i + 1}
                        </span>
                        {label}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11"
                      disabled={!q.active || q.skipMutation.isPending}
                      onClick={() => q.skipActive()}
                    >
                      {t("labeling.skip")} (S)
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">
                    {t("viewerReadonly")}
                  </p>
                )}
              </Panel>
            </div>
          </>
        )}
      </QueryState>

      <Dialog open={q.pushOpen} onOpenChange={q.setPushOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("labeling.pushToDataset")}</DialogTitle>
            <DialogDescription>
              {t("labeling.pushToDatasetBody")}
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              {t("labeling.datasetId")}
            </span>
            <Input
              value={q.pushDatasetId}
              onChange={(e) => q.setPushDatasetId(e.target.value)}
              placeholder={t("labeling.datasetIdPlaceholder")}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => q.setPushOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              loading={q.pushMutation.isPending}
              onClick={() =>
                q.pushMutation.mutate({ dataset_id: q.pushDatasetId })
              }
            >
              {t("labeling.pushToDataset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
