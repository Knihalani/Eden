"use client";

import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeChip } from "@/components/ui/code-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import type { ViolationRow } from "./map-violations";

type Props = {
  violations: ViolationRow[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  filtersActive: boolean;
  selectedId?: string;
  onSelect: (violationId: string) => void;
  onClearFilters: () => void;
  onOpenPolicies: () => void;
};

function severityVariant(severity: string) {
  if (severity === "block") return "error" as const;
  if (severity === "warn") return "warning" as const;
  return "secondary" as const;
}

export function ViolationsTab({
  violations,
  loading,
  error,
  onRetry,
  filtersActive,
  selectedId,
  onSelect,
  onClearFilters,
  onOpenPolicies,
}: Props) {
  const t = useTranslations("guardrails");

  return (
    <QueryState
      loading={loading}
      error={error}
      data={violations ?? []}
      onRetry={onRetry}
      isEmpty={(rows) => rows.length === 0}
      filtersActive={filtersActive}
      emptyKind={filtersActive ? "filter-empty" : "zero-data"}
      loadingSlot={
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      }
      emptySlot={
        <EmptyState
          icon={ShieldAlert}
          variant="panel"
          title={t("violations.empty.title")}
          description={t("violations.empty.body")}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="min-h-11"
              onClick={onOpenPolicies}
              data-testid="guardrails-violations-empty-policies"
            >
              {t("violations.empty.openPolicies")}
            </Button>
          }
        />
      }
      filterEmptySlot={
        <EmptyState
          variant="panel"
          title={t("violations.filterEmpty.title")}
          description={t("violations.filterEmpty.body")}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="min-h-11"
              onClick={onClearFilters}
            >
              {t("violations.filterEmpty.clear")}
            </Button>
          }
        />
      }
    >
      {(rows) => (
        <div
          className="overflow-x-auto rounded-md border border-[var(--border-subtle)]"
          data-testid="guardrails-violations-table"
        >
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2 font-medium">{t("violations.col.time")}</th>
                <th className="px-3 py-2 font-medium">
                  {t("violations.col.policy")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("violations.col.agent")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("violations.col.severity")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("violations.col.action")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("violations.col.trace")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const selected = row.violationId === selectedId;
                return (
                  <tr
                    key={row.violationId}
                    className={cn(
                      "cursor-pointer border-b border-[var(--border-subtle)] last:border-0",
                      selected
                        ? "bg-[var(--accent-faint)]"
                        : "hover:bg-[var(--bg-secondary)]",
                      FOCUS_RING_CLASS,
                    )}
                    tabIndex={0}
                    onClick={() => onSelect(row.violationId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(row.violationId);
                      }
                    }}
                    data-testid={`guardrails-violation-row-${row.violationId}`}
                    aria-selected={selected}
                  >
                    <td className="px-3 py-3 text-[var(--text-secondary)]">
                      {row.createdAt
                        ? new Date(row.createdAt).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-3 py-3">
                      {row.policyId ? (
                        <CodeChip size="sm">{row.policyId}</CodeChip>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)]">
                      {row.agentId ?? "—"}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={severityVariant(String(row.severity))}>
                        {t(
                          `severity.${row.severity === "warn" || row.severity === "log" ? row.severity : "block"}`,
                        )}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)]">
                      {row.action}
                    </td>
                    <td className="max-w-[12rem] truncate px-3 py-3 text-[var(--text-secondary)]">
                      {row.traceId ?? row.payload.slice(0, 48) ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </QueryState>
  );
}
