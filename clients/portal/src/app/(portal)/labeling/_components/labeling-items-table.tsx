"use client";

import Link from "next/link";
import { Tag as TagIcon, Plus, Columns3, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Tag } from "@/components/ui/tag";
import type { LabelingItem } from "@/lib/api";

type Props = {
  items: LabelingItem[];
  filtered: LabelingItem[];
  loading: boolean;
  error: string | null;
  filter: string;
  filterActive: boolean;
  filterMiss: boolean;
  submitting: boolean;
  creatingQueue: boolean;
  onRetry: () => void;
  onClearFilter: () => void;
  onOpenReview: (item: LabelingItem) => void;
  onSkip: (item: LabelingItem) => void;
  onSeedItem: () => void;
  onCreateQueue: () => void;
};

export function LabelingItemsTable({
  items,
  filtered,
  loading,
  error,
  filter,
  filterActive,
  filterMiss,
  submitting,
  creatingQueue,
  onRetry,
  onClearFilter,
  onOpenReview,
  onSkip,
  onSeedItem,
  onCreateQueue,
}: Props) {
  return (
    <QueryState
      loading={loading && items.length === 0}
      error={error ? new Error(error) : null}
      data={items}
      onRetry={onRetry}
      errorTitle="Could not load labeling queue"
      isEmpty={() => filtered.length === 0}
      filtersActive={filterActive}
      emptyKind={filterMiss ? "filter-empty" : "zero-data"}
      filterEmptySlot={
        <EmptyState
          icon={TagIcon}
          title="No matching items"
          description={`Nothing matches “${filter.trim()}”. Clear the filter or seed a new item.`}
          variant="plain"
          action={
            <Button
              className="h-8 max-md:min-h-11"
              variant="outline"
              data-testid="labeling-clear-filter"
              onClick={onClearFilter}
            >
              Clear filter
            </Button>
          }
        />
      }
      emptySlot={
        <EmptyState
          icon={TagIcon}
          title="No items in queue"
          description="Add labeling work from one of three sources, then open a queue board."
          variant="plain"
          action={
            <div
              className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center"
              data-testid="labeling-empty-sources"
              data-wave-e1-empty="labeling"
            >
              <Button asChild className="h-8 max-md:min-h-11" variant="outline">
                <Link href="/traces">From traces</Link>
              </Button>
              <Button
                className="h-8 max-md:min-h-11"
                data-testid="labeling-empty-seed"
                onClick={() => void onSeedItem()}
              >
                <Plus className="h-3.5 w-3.5" /> Seed item
              </Button>
              <Button
                className="h-8 max-md:min-h-11"
                variant="ghost"
                data-testid="labeling-empty-queue"
                onClick={() => void onCreateQueue()}
                disabled={creatingQueue}
              >
                <Columns3 className="h-3.5 w-3.5" /> Create queue
              </Button>
            </div>
          }
        />
      }
    >
      {() => (
        <div className="border-y border-[var(--border-subtle)] py-space-2">
          <DataTable
            loading={loading}
            rows={filtered}
            rowKey={(r) => r.id}
            emptyTitle="No items in queue"
            emptyDescription="Queue is empty."
            emptyIcon={TagIcon}
            columns={[
              {
                key: "prompt",
                header: "Prompt",
                sortable: true,
                cell: (r) => (
                  <button
                    type="button"
                    onClick={() => onOpenReview(r)}
                    className="text-left font-mono text-xs hover:text-[var(--accent)] transition-colors"
                  >
                    {(r.prompt ?? "").slice(0, 120)}
                    {(r.prompt ?? "").length > 120 ? "…" : ""}
                  </button>
                ),
              },
              {
                key: "tags",
                header: "Tags",
                cell: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {(r.tags ?? []).map((t) => (
                      <Tag key={t} className="text-[length:var(--font-size-2xs)]">
                        {t}
                      </Tag>
                    ))}
                  </span>
                ),
              },
              { key: "source", header: "Source", sortable: true },
              { key: "annotations_count", header: "Annotations", sortable: true, align: "right" },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (r) => new Date(r.created_at).toLocaleString(),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                cell: (r) => (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      className="h-8 max-md:min-h-11"
                      variant="outline"
                      onClick={() => onOpenReview(r)}
                      aria-label={`Review ${r.id}`}
                    >
                      Review
                    </Button>
                    <Button
                      className="h-8 max-md:min-h-11"
                      variant="ghost"
                      onClick={() => void onSkip(r)}
                      disabled={submitting}
                      aria-label={`Skip ${r.id}`}
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}
    </QueryState>
  );
}
