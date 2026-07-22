"use client";

import type { ImproveQueueItem } from "@/lib/api";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import {
  isLegacyProposedPatch,
  planKindFromItem,
  severityClass,
} from "./queue-helpers";

export function QueueItemCard({
  item,
  selected,
  onSelect,
}: {
  item: ImproveQueueItem;
  selected?: boolean;
  onSelect: (item: ImproveQueueItem) => void;
}) {
  const kind = planKindFromItem(item);

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      data-testid="improve-queue-item"
      data-selected={selected ? "true" : undefined}
      className={cn(
        "w-full rounded-md bg-[var(--bg-primary)]/60 p-space-3 text-left flex flex-col gap-space-2 transition-colors",
        "hover:bg-[var(--bg-secondary)]/50",
        FOCUS_RING_CLASS,
        selected && "ring-1 ring-[var(--border-default)] bg-[var(--bg-secondary)]/40",
      )}
    >
      <p className="text-sm font-medium leading-snug text-[var(--text-primary)] line-clamp-2">
        {item.title}
      </p>

      <p className={cn("text-xs font-medium capitalize", severityClass(item.severity))}>
        {item.severity}
      </p>

      {item.item_type === "auto_heal" ? (
        <p className="text-xs text-[var(--accent)]">Auto-heal event</p>
      ) : null}
      {item.item_type === "policy_denial" ? (
        <p className="text-xs text-[var(--error)]">Policy denial</p>
      ) : null}
      {isLegacyProposedPatch(item) ? (
        <p className="text-xs text-[var(--text-muted)]">Legacy patch · read-only</p>
      ) : null}

      <p className="text-xs text-[var(--text-muted)]">
        {item.item_type}
        {item.source ? ` · ${item.source}` : ""}
        {item.autonomy_tier_required ? ` · Tier ${item.autonomy_tier_required}` : ""}
      </p>

      {kind ? (
        <div>
          <PlanKindBadge kind={kind} />
        </div>
      ) : null}

      {item.blocked_reason ? (
        <p
          className={cn(
            "text-xs",
            item.item_type === "policy_denial"
              ? "text-[var(--error)]"
              : "text-[var(--warning)]",
          )}
        >
          {item.item_type === "policy_denial" ? "Denied: " : "Blocked: "}
          {item.blocked_reason}
        </p>
      ) : null}
    </button>
  );
}
