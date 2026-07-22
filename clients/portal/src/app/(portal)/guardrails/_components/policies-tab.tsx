"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Shield } from "lucide-react";
import type { GuardrailPolicyRow } from "@/lib/api/resources";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeChip } from "@/components/ui/code-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

type Props = {
  policies: GuardrailPolicyRow[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  q?: string;
  severity?: string;
  agentId?: string;
  selectedId?: string;
  canMutate: boolean;
  onSelect: (policyId: string) => void;
  onNewPolicy: () => void;
  onClearFilters: () => void;
};

function attachedCount(policy: GuardrailPolicyRow): number {
  const cfg = policy.config ?? {};
  const ids = cfg.agentIds ?? cfg.agent_ids;
  return Array.isArray(ids) ? ids.length : 0;
}

function matchesSeverity(policy: GuardrailPolicyRow, severity?: string): boolean {
  if (!severity) return true;
  return String(policy.action ?? "").toLowerCase() === severity;
}

export function PoliciesTab({
  policies,
  loading,
  error,
  onRetry,
  q,
  severity,
  agentId,
  selectedId,
  canMutate,
  onSelect,
  onNewPolicy,
  onClearFilters,
}: Props) {
  const t = useTranslations("guardrails");

  const filtersActive = Boolean(q?.trim() || severity || agentId);

  const filtered = useMemo(() => {
    const rows = policies ?? [];
    const needle = q?.trim().toLowerCase();
    return rows.filter((p) => {
      if (!matchesSeverity(p, severity)) return false;
      if (agentId) {
        const ids = p.config?.agentIds ?? p.config?.agent_ids;
        const list = Array.isArray(ids) ? ids.map(String) : [];
        if (!list.includes(agentId)) return false;
      }
      if (needle) {
        const hay = [p.name, p.policy_id, p.kind, p.action, p.type]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [policies, q, severity, agentId]);

  return (
    <QueryState
      loading={loading}
      error={error}
      data={filtered}
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
          icon={Shield}
          variant="panel"
          title={t("policies.empty.title")}
          description={t("policies.empty.body")}
          action={
            canMutate ? (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                onClick={onNewPolicy}
                data-testid="guardrails-empty-new-policy"
              >
                {t("policies.new")}
              </Button>
            ) : undefined
          }
        />
      }
      filterEmptySlot={
        <EmptyState
          variant="panel"
          title={t("policies.filterEmpty.title")}
          description={t("policies.filterEmpty.body")}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="min-h-11"
              onClick={onClearFilters}
            >
              {t("policies.filterEmpty.clear")}
            </Button>
          }
        />
      }
    >
      {(rows) => (
        <div
          className="overflow-x-auto rounded-md border border-[var(--border-subtle)]"
          data-testid="guardrails-policies-table"
        >
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2 font-medium">{t("policies.col.name")}</th>
                <th className="px-3 py-2 font-medium">
                  {t("policies.col.severity")}
                </th>
                <th className="px-3 py-2 font-medium">{t("policies.col.scope")}</th>
                <th className="px-3 py-2 font-medium">
                  {t("policies.col.agents")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("policies.col.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((policy) => {
                const selected = policy.policy_id === selectedId;
                const sev = String(policy.action ?? "block").toLowerCase();
                return (
                  <tr
                    key={policy.policy_id}
                    className={cn(
                      "cursor-pointer border-b border-[var(--border-subtle)] last:border-0",
                      selected
                        ? "bg-[var(--accent-faint)]"
                        : "hover:bg-[var(--bg-secondary)]",
                      FOCUS_RING_CLASS,
                    )}
                    tabIndex={0}
                    onClick={() => onSelect(policy.policy_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(policy.policy_id);
                      }
                    }}
                    data-testid={`guardrails-policy-row-${policy.policy_id}`}
                    aria-selected={selected}
                  >
                    <td className="px-3 py-3">
                      <div className="font-medium text-[var(--text-primary)]">
                        {policy.name}
                      </div>
                      <CodeChip size="sm" className="mt-1">
                        {policy.policy_id}
                      </CodeChip>
                    </td>
                    <td className="px-3 py-3">
                      <Badge
                        variant={
                          sev === "block"
                            ? "error"
                            : sev === "warn"
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {t(`severity.${sev === "warn" || sev === "log" ? sev : "block"}`)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)]">
                      {policy.kind === "content" ||
                      policy.kind === "pii" ||
                      policy.kind === "hallucination" ||
                      policy.kind === "injection"
                        ? t(`policies.kinds.${policy.kind}`)
                        : policy.kind}
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)]">
                      {attachedCount(policy)}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={policy.enabled ? "success" : "secondary"}>
                        {policy.enabled
                          ? t("policies.status.enabled")
                          : t("policies.status.disabled")}
                      </Badge>
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
