"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { TraceScoreRow } from "@/app/(portal)/_hooks/use-trace-detail";
import { Button } from "@/components/ui/button";
import { AddToDatasetDialog } from "@/components/evals/add-to-dataset-dialog";

type Props = {
  scores: TraceScoreRow[];
  loading?: boolean;
  traceId: string;
};

export function ScoresCanvas({ scores, loading, traceId }: Props) {
  const t = useTranslations("traces.scores");
  const tEvals = useTranslations("evals.addToDataset");
  const [addOpen, setAddOpen] = useState(false);

  if (loading) {
    return (
      <p className="px-3 py-6 text-sm text-[var(--text-muted)]" data-testid="scores-canvas-loading">
        {t("loading")}
      </p>
    );
  }

  if (scores.length === 0) {
    return (
      <div className="space-y-3 px-3 py-6" data-testid="scores-canvas-empty">
        <p className="m-0 text-sm text-[var(--text-muted)]">{t("empty")}</p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setAddOpen(true)}
          data-testid="scores-add-to-dataset"
        >
          {tEvals("trigger")}
        </Button>
        <AddToDatasetDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          traceId={traceId}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2 px-3 py-2" data-testid="scores-canvas" data-mode="scores">
      {scores.map((s) => (
        <div
          key={s.id}
          className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--border-subtle)] py-2"
        >
          <div className="min-w-0">
            <p className="m-0 text-sm font-medium text-[var(--text-primary)]">{s.name}</p>
            {s.rationale ? (
              <p className="m-0 mt-0.5 text-xs text-[var(--text-muted)]">{s.rationale}</p>
            ) : null}
            {s.spanId ? (
              <p className="m-0 mt-0.5 font-mono text-2xs text-[var(--text-muted)]">
                {s.spanId}
              </p>
            ) : null}
          </div>
          <span className="font-mono text-sm tabular-nums text-[var(--text-primary)]">
            {s.score.toFixed(2)}
          </span>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="mt-2"
        onClick={() => setAddOpen(true)}
        data-testid="scores-add-to-dataset"
      >
        {tEvals("trigger")}
      </Button>
      <AddToDatasetDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        traceId={traceId}
      />
    </div>
  );
}
