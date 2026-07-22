"use client";

import { useTranslations } from "next-intl";
import {
  IssueWorkflowBadge,
  SeverityBadge,
} from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import {
  formatRelative,
  severityBadgeKey,
  type IssueRow,
  type IssuesTab,
} from "./issue-map";

type Props = {
  rows: IssueRow[];
  selectedId?: string;
  focusedIndex?: number;
  tab: IssuesTab;
  onSelect: (issueId: string) => void;
  onFocusIndex?: (index: number) => void;
};

export function IssuesTable({
  rows,
  selectedId,
  focusedIndex = -1,
  tab,
  onSelect,
  onFocusIndex,
}: Props) {
  const t = useTranslations("issues.list");

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="issues-table">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colTitle")}</th>
            <th className="px-3 py-2 font-medium">{t("colSeverity")}</th>
            <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
            <th className="px-3 py-2 font-medium">{t("colAgent")}</th>
            <th className="px-3 py-2 font-medium">
              {tab === "incidents" ? t("colOccurrencesCluster") : t("colOccurrences")}
            </th>
            <th className="px-3 py-2 font-medium">{t("colUpdated")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = row.issueId === selectedId;
            const focused = focusedIndex === index;
            return (
              <tr
                key={row.issueId}
                tabIndex={0}
                data-testid={`issues-row-${row.issueId}`}
                data-selected={selected ? "true" : "false"}
                data-focused={focused ? "true" : "false"}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)] transition-colors",
                  "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                  (selected || focused) && "bg-[var(--bg-tertiary)]",
                )}
                onClick={() => onSelect(row.issueId)}
                onFocus={() => onFocusIndex?.(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(row.issueId);
                }}
              >
                <td className="px-3 py-2.5 font-medium text-[var(--text-primary)]">
                  {row.title}
                </td>
                <td className="px-3 py-2.5">
                  <SeverityBadge severity={severityBadgeKey(row.severity)} />
                </td>
                <td className="px-3 py-2.5">
                  <IssueWorkflowBadge status={row.status} />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-[var(--text-secondary)]">
                  {row.agentId ?? "—"}
                </td>
                <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                  ×{row.occurrenceCount}
                </td>
                <td className="px-3 py-2.5 text-[var(--text-secondary)]">
                  {formatRelative(row.lastSeenAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
