import type { ImproveQueueItem, ImprovementPlanKind } from "@/lib/api";
import type { ImproveQueueColumnId } from "./improve-constants";
import { queueColumnId } from "./improve-constants";

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  p0: 0,
  high: 1,
  p1: 1,
  medium: 2,
  p2: 2,
  low: 3,
  p3: 3,
};

export function severityRank(sev: string): number {
  return SEVERITY_RANK[sev.toLowerCase()] ?? 4;
}

export function severityClass(sev: string): string {
  const s = sev.toLowerCase();
  if (s === "critical" || s === "high" || s === "p0" || s === "p1") {
    return "text-[var(--error)]";
  }
  if (s === "medium" || s === "p2") return "text-[var(--warning)]";
  return "text-[var(--text-muted)]";
}

export function isN23PlanRef(item: ImproveQueueItem): boolean {
  return (
    item.ref.startsWith("improvement_plan:") ||
    item.item_type === "improvement_plan" ||
    item.source === "improvement_plans"
  );
}

export function isLegacyProposedPatch(item: ImproveQueueItem): boolean {
  return (
    item.ref.startsWith("proposed_patch:") || item.source === "proposed_patches"
  );
}

/** Detail URL for N23 plans only — never invent /improve/plans/{legacyPatchId}. */
export function planHref(item: ImproveQueueItem): string | null {
  if (item.ref.startsWith("improvement_plan:")) {
    const id = item.ref.split(":").slice(1).join(":");
    return id ? `/improve/plans/${id}` : null;
  }
  const planId = item.payload?.plan_id;
  if (
    typeof planId === "string" &&
    planId &&
    (item.source === "improvement_plans" || item.item_type === "improvement_plan")
  ) {
    return `/improve/plans/${planId}`;
  }
  if (isLegacyProposedPatch(item) || item.href?.startsWith("/pr-suggestions")) {
    return "/improve/plans";
  }
  return item.href ?? null;
}

export function planKindFromItem(item: ImproveQueueItem): ImprovementPlanKind | null {
  const kind = item.payload?.plan_kind;
  if (typeof kind === "string" && kind) return kind as ImprovementPlanKind;
  if (isN23PlanRef(item)) return "code_patch";
  return null;
}

export function canApproveQueueItem(item: ImproveQueueItem): boolean {
  if (item.blocked_reason) return false;
  if (item.column !== "proposed" && item.column !== "needs_you") return false;
  return (
    item.ref.startsWith("closed_loop:") || item.ref.startsWith("improvement_plan:")
  );
}

export function isPromotionItem(item: ImproveQueueItem): boolean {
  return (
    item.ref.startsWith("promotion:") ||
    item.item_type === "promotion" ||
    item.source === "promotions"
  );
}

export function sortQueueItems(items: ImproveQueueItem[]): ImproveQueueItem[] {
  return [...items].sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return String(a.title).localeCompare(String(b.title));
  });
}

export function itemsForView(
  items: ImproveQueueItem[],
  view: ImproveQueueColumnId,
): ImproveQueueItem[] {
  return sortQueueItems(items.filter((item) => queueColumnId(item.column) === view));
}

/** Single primary act for the selected queue item. */
export type QueuePrimaryAction =
  | { kind: "approve"; label: "Approve" }
  | { kind: "open_plan"; label: "Open plan"; href: string }
  | { kind: "promote"; label: "Promote"; href: string }
  | { kind: "snooze"; label: "Snooze" };

export function primaryActionForItem(item: ImproveQueueItem): QueuePrimaryAction {
  if (canApproveQueueItem(item)) {
    return { kind: "approve", label: "Approve" };
  }
  if (isPromotionItem(item)) {
    return { kind: "promote", label: "Promote", href: "/artifacts" };
  }
  const href = planHref(item);
  if (href) {
    return { kind: "open_plan", label: "Open plan", href };
  }
  return { kind: "snooze", label: "Snooze" };
}
