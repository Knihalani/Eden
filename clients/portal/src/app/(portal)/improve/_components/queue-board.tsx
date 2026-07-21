"use client";

import { useMemo } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { VirtualizedList, ViewsMenu } from "@/components/portal-os";
import type { ViewPreset } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { ImproveFeatureDisabledState } from "@/components/improve/feature-disabled-state";
import { issueFullHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import {
  IMPROVE_QUEUE_COLUMNS,
  IMPROVE_QUEUE_VIEW_PRESETS,
  type ImproveQueueColumnId,
} from "./improve-constants";
import { itemsForView } from "./queue-helpers";
import { QueueItemCard } from "./queue-item-card";
import { QueueDetailPanel } from "./queue-detail-panel";
import type { ImproveQueueController } from "./use-improve-queue";

const QUEUE_ROW_HEIGHT = 112;

export function QueueBoard({ q }: { q: ImproveQueueController }) {
  const viewItems = useMemo(
    () => itemsForView(q.displayItems, q.activeView),
    [q.displayItems, q.activeView],
  );

  const viewMeta =
    IMPROVE_QUEUE_COLUMNS.find((c) => c.id === q.activeView) ??
    IMPROVE_QUEUE_COLUMNS[0];

  const viewIndex = viewItems.findIndex((i) => i.ref === q.selectedRef);

  const selectView = (viewId: string) => {
    const next =
      (IMPROVE_QUEUE_VIEW_PRESETS.find((p) => p.id === viewId)?.id as
        | ImproveQueueColumnId
        | undefined) ?? "needs_you";
    q.setActiveView(next);
    q.setSelectedRef(null);
  };

  if (q.featureDisabled) {
    return <ImproveFeatureDisabledState />;
  }

  return (
    <div data-testid="improve-queue-board" className="flex flex-col gap-space-3">
      {q.refreshedAt ? (
        <p className="text-xs text-[var(--text-muted)]">
          Updated {new Date(q.refreshedAt).toLocaleString()}
        </p>
      ) : null}

      {q.issueFilter ? (
        <div
          data-testid="improve-issue-filter"
          className="flex flex-wrap items-center gap-space-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 px-space-3 py-space-2 text-sm"
        >
          <span className="text-[var(--text-secondary)]">
            Filtered to issue{" "}
            <code className="font-mono text-xs text-[var(--text-primary)]">
              {q.issueFilter}
            </code>
          </span>
          <Button asChild variant="outline" size="sm" className="min-h-11">
            <Link href={issueFullHref(q.issueFilter)}>Open issue</Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="min-h-11"
            aria-label="Clear issue filter"
          >
            <Link href="/improve">
              <X className="mr-1 h-3.5 w-3.5" />
              Clear
            </Link>
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {viewMeta.label}
            <span className="ml-space-2 text-xs font-normal text-[var(--text-muted)]">
              {viewItems.length}
            </span>
          </h2>
          <p className="text-xs text-[var(--text-muted)]">{viewMeta.hint}</p>
        </div>
        <ViewsMenu
          views={[]}
          presets={IMPROVE_QUEUE_VIEW_PRESETS as ViewPreset[]}
          activeViewId={q.activeView}
          onSelect={selectView}
          onSave={async () => {}}
          onDiscard={() => selectView("needs_you")}
          className="shrink-0"
        />
      </div>

      <QueryState
        loading={q.loading && q.items.length === 0}
        error={q.queueError}
        data={q.queueData}
        onRetry={() => void q.load()}
        errorTitle="Could not load the improvement queue"
        isEmpty={(d) => {
          const all = d?.items ?? [];
          if (all.length === 0) return true;
          if (q.issueFilter) return q.displayItems.length === 0;
          return false;
        }}
        loadingSlot={<LoadingSkeleton variant="table" lines={5} className="p-0 max-w-none" />}
        emptySlot={
          q.issueFilter && q.items.length > 0 ? (
            <EmptyState
              variant="plain"
              title="No queue items for this issue"
              description="Nothing in the Improve queue matches this issue yet."
              action={
                <Button asChild className="min-h-11">
                  <Link href="/improve">Clear filter</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              title="Nothing in the queue"
              description={U20_EMPTY_COPY.improveQueue}
              action={
                <Button asChild className="min-h-11">
                  <Link href="/issues">View Issues</Link>
                </Button>
              }
            />
          )
        }
      >
        {() => (
          <div className="relative flex min-h-0 flex-col xl:flex-row xl:gap-space-3">
            <div className="min-w-0 flex-1" data-wave11-mobile="cards">
              {viewItems.length === 0 ? (
                <EmptyState
                  variant="plain"
                  title={`Nothing in ${viewMeta.label}`}
                  description="Switch views or clear filters to see other queue items."
                  action={
                    <Button
                      className="min-h-11"
                      onClick={() => selectView("needs_you")}
                    >
                      Needs you
                    </Button>
                  }
                />
              ) : (
                <VirtualizedList
                  items={viewItems}
                  rowKey={(item) => item.ref}
                  rowHeight={QUEUE_ROW_HEIGHT}
                  className="max-h-[min(36rem,70vh)] flex flex-col gap-space-2"
                >
                  {(item) => (
                    <QueueItemCard
                      item={item}
                      selected={q.selectedRef === item.ref}
                      onSelect={(next) => q.setSelectedRef(next.ref)}
                    />
                  )}
                </VirtualizedList>
              )}
            </div>

            {q.selectedItem ? (
              <QueueDetailPanel
                item={q.selectedItem}
                busy={q.busyRef === q.selectedItem.ref}
                onClose={() => q.setSelectedRef(null)}
                onPrev={
                  viewIndex > 0
                    ? () => q.setSelectedRef(viewItems[viewIndex - 1]!.ref)
                    : undefined
                }
                onNext={
                  viewIndex >= 0 && viewIndex < viewItems.length - 1
                    ? () => q.setSelectedRef(viewItems[viewIndex + 1]!.ref)
                    : undefined
                }
                onApprove={q.onApprove}
                onSnooze={q.onSnooze}
              />
            ) : null}
          </div>
        )}
      </QueryState>
    </div>
  );
}
