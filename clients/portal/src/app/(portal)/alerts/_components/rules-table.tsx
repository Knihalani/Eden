"use client";

import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StatusDescriptor } from "@/lib/types";
import { CheckCircle2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RuleRow } from "./alert-types";

const RULE_ENABLED_DESCRIPTORS: Record<string, StatusDescriptor> = {
  enabled: {
    label: "On",
    className:
      "bg-[var(--terminal-faint)] text-[var(--terminal)] border-[var(--border-subtle)]",
    icon: CheckCircle2,
  },
  disabled: {
    label: "Off",
    className:
      "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]",
    icon: Circle,
  },
};

type Props = {
  rows: RuleRow[];
  selectedId?: string;
  focusedIndex?: number;
  onSelect: (ruleId: string) => void;
  onFocusIndex?: (index: number) => void;
};

export function RulesTable({
  rows,
  selectedId,
  focusedIndex = -1,
  onSelect,
  onFocusIndex,
}: Props) {
  const t = useTranslations("alerts.rules");

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="alerts-rules-table">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colName")}</th>
            <th className="px-3 py-2 font-medium">{t("colEnabled")}</th>
            <th className="px-3 py-2 font-medium">{t("colType")}</th>
            <th className="px-3 py-2 font-medium">{t("colChannels")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = row.ruleId === selectedId;
            const focused = focusedIndex === index;
            return (
              <tr
                key={row.ruleId}
                tabIndex={0}
                data-selected={selected ? "true" : "false"}
                data-focused={focused ? "true" : "false"}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                  "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                  (selected || focused) && "bg-[var(--bg-tertiary)]",
                )}
                onClick={() => onSelect(row.ruleId)}
                onFocus={() => onFocusIndex?.(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.ruleId);
                }}
              >
                <td className="px-3 py-2.5 font-medium text-[var(--text-primary)]">
                  {row.name}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge
                    status={row.enabled ? "enabled" : "disabled"}
                    descriptors={RULE_ENABLED_DESCRIPTORS}
                  />
                </td>
                <td className="px-3 py-2.5 capitalize text-[var(--text-secondary)]">
                  {row.type}
                </td>
                <td className="px-3 py-2.5 text-[var(--text-secondary)]">
                  {row.channelRefs.length
                    ? row.channelRefs.join(", ")
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
