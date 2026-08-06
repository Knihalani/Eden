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
}: {
  items: readonly LabelingItemListEntry[];
  perItem: LabelingAgreementReport["per_item"] | null | undefined;
  onSelect: (itemId: string) => void;
  onStartLabeling: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
        <h3 className="type-ui text-[var(--text-secondary)]">Unassigned items</h3>
        <button type="button" className="ds-btn ds-btn-primary ds-btn-sm" onClick={onStartLabeling}>
          Start labeling
        </button>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No items in the pool" compact />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((item) => {
            const agreement = perItem?.[item.id]?.agreement;
            const needsAttention = item.annotations_count >= 1 && agreement == null;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className="flex w-full flex-col gap-1 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--bg-inset)] sm:px-5"
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
