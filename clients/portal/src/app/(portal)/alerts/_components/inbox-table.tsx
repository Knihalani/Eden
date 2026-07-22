"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Circle, VolumeX } from "lucide-react";
import { SeverityBadge, StatusBadge } from "@/components/ui/status-badge";
import type { StatusDescriptor } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { AlertRow } from "./alert-types";
import { formatRelativeTime } from "./alert-links";

const ALERT_STATUS_DESCRIPTORS: Record<string, StatusDescriptor> = {
  open: {
    label: "Open",
    className:
      "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--border-subtle)]",
    icon: AlertTriangle,
  },
  acked: {
    label: "Acked",
    className:
      "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    icon: CheckCircle2,
  },
  silenced: {
    label: "Silenced",
    className:
      "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]",
    icon: VolumeX,
  },
  resolved: {
    label: "Resolved",
    className:
      "bg-[var(--terminal-faint)] text-[var(--terminal)] border-[var(--border-subtle)]",
    icon: Circle,
  },
};

type Props = {
  rows: AlertRow[];
  selectedId?: string;
  focusedIndex?: number;
  onSelect: (alertId: string) => void;
  onFocusIndex?: (index: number) => void;
};

export function InboxTable({
  rows,
  selectedId,
  focusedIndex = -1,
  onSelect,
  onFocusIndex,
}: Props) {
  const t = useTranslations("alerts.inbox");

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="alerts-inbox-table">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colFired")}</th>
            <th className="px-3 py-2 font-medium">{t("colSeverity")}</th>
            <th className="px-3 py-2 font-medium">{t("colTitle")}</th>
            <th className="px-3 py-2 font-medium">{t("colAgent")}</th>
            <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = row.alertId === selectedId;
            const focused = focusedIndex === index;
            return (
              <tr
                key={row.alertId}
                tabIndex={0}
                data-selected={selected ? "true" : "false"}
                data-focused={focused ? "true" : "false"}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                  "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                  (selected || focused) && "bg-[var(--bg-tertiary)]",
                )}
                onClick={() => onSelect(row.alertId)}
                onFocus={() => onFocusIndex?.(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.alertId);
                }}
              >
                <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                  {formatRelativeTime(row.firedAt)}
                </td>
                <td className="px-3 py-2.5">
                  <SeverityBadge severity={row.severity} />
                </td>
                <td className="px-3 py-2.5 font-medium text-[var(--text-primary)]">
                  {row.title}
                </td>
                <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                  {row.agentId ?? "—"}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge
                    status={row.status}
                    descriptors={ALERT_STATUS_DESCRIPTORS}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
