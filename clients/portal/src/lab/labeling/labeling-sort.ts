import type {
  LabelingAgreementReport,
  LabelingItemListEntry,
} from "@/lib/api/labeling";

/**
 * Disagreement-first ordering for the `/labeling` "Unassigned items"
 * panel (FEAT-82).
 *
 * Items with 1+ annotations are moved to the front, ordered ascending
 * by `per_item[id].agreement` — lower agreement means more
 * disagreement between annotators, so those items surface first and
 * need a human to reconcile them. The backend
 * (`LabelingService.compute_iaa`) only populates `per_item[id]` once
 * an item has 2+ annotations (pairwise kappa needs a pair); a
 * single-annotation item has no computed score yet at all, which is
 * itself unresolved risk, so those sort ahead of every item with a
 * *known* agreement value. Items with zero annotations are left at
 * the tail in their incoming (recency) order — there's nothing to
 * disagree about yet.
 */
export function sortItemsByDisagreement(
  items: readonly LabelingItemListEntry[],
  perItem: LabelingAgreementReport["per_item"] | null | undefined,
): LabelingItemListEntry[] {
  const agreementOf = (id: string): number | undefined => perItem?.[id]?.agreement;

  return [...items].sort((a, b) => {
    const aAnnotated = a.annotations_count >= 1;
    const bAnnotated = b.annotations_count >= 1;
    if (aAnnotated !== bAnnotated) return aAnnotated ? -1 : 1;
    if (!aAnnotated && !bAnnotated) return 0;

    const aAgr = agreementOf(a.id);
    const bAgr = agreementOf(b.id);
    if (aAgr == null && bAgr == null) return 0;
    if (aAgr == null) return -1;
    if (bAgr == null) return 1;
    return aAgr - bAgr;
  });
}
