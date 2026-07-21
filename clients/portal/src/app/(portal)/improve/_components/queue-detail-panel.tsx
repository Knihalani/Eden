"use client";

import Link from "next/link";
import { Check, Clock } from "lucide-react";

import type { ImproveQueueItem } from "@/lib/api";
import { DetailPanelShell } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { cn } from "@/lib/utils";
import {
  planKindFromItem,
  primaryActionForItem,
  severityClass,
} from "./queue-helpers";

export function QueueDetailPanel({
  item,
  busy,
  onClose,
  onPrev,
  onNext,
  onApprove,
  onSnooze,
}: {
  item: ImproveQueueItem;
  busy: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onApprove: (item: ImproveQueueItem) => void;
  onSnooze: (item: ImproveQueueItem) => void;
}) {
  const kind = planKindFromItem(item);
  const primary = primaryActionForItem(item);

  const primaryButton =
    primary.kind === "approve" ? (
      <Button
        size="sm"
        className="min-h-11"
        disabled={busy}
        data-testid="improve-queue-primary-cta"
        onClick={() => void onApprove(item)}
      >
        <Check className="mr-1 h-3.5 w-3.5" />
        {primary.label}
      </Button>
    ) : primary.kind === "open_plan" || primary.kind === "promote" ? (
      <Button asChild size="sm" className="min-h-11" data-testid="improve-queue-primary-cta">
        <Link href={primary.href}>{primary.label}</Link>
      </Button>
    ) : (
      <Button
        size="sm"
        className="min-h-11"
        disabled={busy}
        data-testid="improve-queue-primary-cta"
        onClick={() => void onSnooze(item)}
      >
        <Clock className="mr-1 h-3.5 w-3.5" />
        {primary.label}
      </Button>
    );

  return (
    <DetailPanelShell
      open
      mobileDrawer
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      title={item.title}
      headerActions={primaryButton}
    >
      <div className="flex flex-col gap-space-3 p-space-4" data-testid="improve-queue-detail">
        <p className={cn("text-xs font-medium capitalize", severityClass(item.severity))}>
          {item.severity}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {item.item_type}
          {item.source ? ` · ${item.source}` : ""}
          {item.autonomy_tier_required ? ` · Tier ${item.autonomy_tier_required}` : ""}
          {item.status ? ` · ${item.status}` : ""}
        </p>
        {kind ? <PlanKindBadge kind={kind} /> : null}
        {item.blocked_reason ? (
          <p
            className={cn(
              "text-sm",
              item.item_type === "policy_denial"
                ? "text-[var(--error)]"
                : "text-[var(--warning)]",
            )}
          >
            {item.item_type === "policy_denial" ? "Denied: " : "Blocked: "}
            {item.blocked_reason}
          </p>
        ) : null}
        {primary.kind !== "snooze" ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 self-start"
            disabled={busy}
            onClick={() => void onSnooze(item)}
          >
            <Clock className="mr-1 h-3.5 w-3.5" />
            Snooze 24h
          </Button>
        ) : null}
      </div>
    </DetailPanelShell>
  );
}
