import { useMemo, useState } from "react";
import { StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { formatRelativeTime } from "@/lib/format";
import type {
  LabelingAgreementReport,
  LabelingItemListEntry,
} from "@/lib/api/labeling";

/**
 * "Unassigned items" panel for `/labeling` (FEAT-82) — sourced from
 * `labelingApi.listItems`, pre-sorted disagreement-first by the caller
 * (see `labeling-sort.ts`). Selecting a row hands off to
 * `/labeling/annotate?item=<id>` as a best-effort hint (the backend
 * has no get-item-by-id endpoint, so the annotate page still leases
 * its working set via `pop` — see that page's doc comment).
 */
export function LabelingUnassignedPanel({
  items,
  perItem,
  onSelect,
  onStartLabeling,
  onSkipSelected,
  skipping = false,
}: {
  items: readonly LabelingItemListEntry[];
  perItem: LabelingAgreementReport["per_item"] | null | undefined;
  onSelect: (itemId: string) => void;
  onStartLabeling: () => void;
  onSkipSelected?: (itemIds: string[]) => void;
  skipping?: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const itemIdSet = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const visibleSelected = useMemo(
    () => new Set([...selectedIds].filter((id) => itemIdSet.has(id))),
    [selectedIds, itemIdSet],
  );
  const selectedCount = visibleSelected.size;
  const allSelected = items.length > 0 && selectedCount === items.length;

  const toggleItem = (itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };

  const handleSkipSelected = () => {
    if (!onSkipSelected || selectedCount === 0 || skipping) return;
    onSkipSelected([...visibleSelected]);
    setSelectedIds(new Set());
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {items.length > 0 && onSkipSelected ? (
            <label className="flex items-center gap-2 type-meta text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Select all items"
                className="accent-[var(--accent)]"
              />
            </label>
          ) : null}
          <h3 className="type-ui text-[var(--text-secondary)]">Unassigned items</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onSkipSelected ? (
            <button
              type="button"
              className="ds-btn ds-btn-outline ds-btn-sm"
              disabled={selectedCount === 0 || skipping}
              onClick={handleSkipSelected}
            >
              {skipping
                ? "Skipping…"
                : selectedCount > 0
                  ? `Skip selected (${selectedCount})`
                  : "Skip selected"}
            </button>
          ) : null}
          <button type="button" className="ds-btn ds-btn-primary ds-btn-sm" onClick={onStartLabeling}>
            Start labeling
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No items in the pool" compact />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((item) => {
            const agreement = perItem?.[item.id]?.agreement;
            const needsAttention = item.annotations_count >= 1 && agreement == null;
            const checked = visibleSelected.has(item.id);
            return (
              <li key={item.id} className="flex border-b border-[var(--line)]">
                {onSkipSelected ? (
                  <label className="flex shrink-0 items-start px-3 py-3 sm:px-4">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(item.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${item.prompt}`}
                      className="accent-[var(--accent)]"
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className="flex min-w-0 flex-1 flex-col gap-1 py-2.5 pr-4 text-left transition-colors hover:bg-[var(--bg-inset)] sm:pr-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {agreement != null ? (
                      <StatusChip tone={agreement < 0.5 ? "fail" : "neutral"}>
                        agreement {agreement.toFixed(2)}
                      </StatusChip>
                    ) : needsAttention ? (
                      <StatusChip tone="fail">needs 2nd pass</StatusChip>
                    ) : (
                      <StatusChip tone="neutral">unlabeled</StatusChip>
                    )}
                    <span className="type-meta">
                      {item.annotations_count} annotation{item.annotations_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="type-body truncate text-[var(--text)]">{item.prompt}</span>
                  <span className="type-meta">
                    {item.source}
                    {item.tags.length > 0 ? ` · ${item.tags.join(", ")}` : ""}
                    {item.created_at ? ` · ${formatRelativeTime(item.created_at)}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
