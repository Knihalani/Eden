"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DetailPanelShell } from "@/components/portal-os";
import {
  experimentHref,
  playgroundHref,
} from "@/lib/portal-cross-links";
import type { Dataset } from "@/lib/api";

export function DatasetsDetailPeek({
  selected,
  onClose,
  onPrev,
  onNext,
}: {
  selected: Dataset;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  return (
    <DetailPanelShell
      open
      onClose={onClose}
      title={selected.name}
      onPrev={onPrev}
      onNext={onNext}
    >
      <div className="space-y-space-4 p-space-4 text-sm" data-testid="dataset-detail-peek">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-[var(--text-muted)]">Rows</dt>
            <dd className="font-medium">
              {(selected as { row_count?: number }).row_count ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--text-muted)]">Columns</dt>
            <dd className="font-medium">
              {(selected as { column_count?: number }).column_count ?? "—"}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-[var(--text-muted)]">Created</dt>
            <dd className="font-medium">
              {new Date(selected.created_at).toLocaleString()}
            </dd>
          </div>
          {selected.description ? (
            <div className="col-span-2">
              <dt className="text-xs text-[var(--text-muted)]">Description</dt>
              <dd className="text-[var(--text-secondary)]">{selected.description}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-space-3">
          <Button asChild className="h-8 max-md:min-h-11">
            <Link href={`/datasets/${selected.id}`}>Open spreadsheet</Link>
          </Button>
          <Button asChild variant="outline" className="h-8 max-md:min-h-11">
            <Link href={playgroundHref()}>Playground</Link>
          </Button>
          <Button asChild variant="ghost" className="h-8 max-md:min-h-11">
            <Link href={experimentHref()}>Experiments</Link>
          </Button>
        </div>
      </div>
    </DetailPanelShell>
  );
}
