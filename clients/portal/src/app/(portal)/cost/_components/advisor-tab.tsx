"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Lightbulb, Sparkles } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  modelAdvisorApi,
  type RecommendationDto,
} from "@/lib/api";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { costWindowDays, costWindowHours, fmtUsd } from "./cost-format";

const DEFAULT_CANDIDATES = [
  { provider: "openai", model_id: "gpt-4o" },
  { provider: "openai", model_id: "gpt-4o-mini" },
  { provider: "anthropic", model_id: "claude-sonnet-4-6" },
  { provider: "google", model_id: "gemini-2.5-flash" },
] as const;

type RecRow = {
  id: string;
  kind: "recommended" | "runner_up" | "cache";
  title: string;
  rationale: string;
  savingsUsd: number | null;
  confidence: number;
  model?: string;
};

type Props = {
  pastHours?: string;
  agentId?: string;
  model?: string;
  canAct: boolean;
};

function buildRows(
  rec: RecommendationDto,
  modelFilter?: string,
): RecRow[] {
  const rows: RecRow[] = [];
  if (!rec.empty_history) {
    rows.push({
      id: `rec-${rec.recommended_provider}-${rec.recommended_model_id}`,
      kind: "recommended",
      title: `${rec.recommended_provider}/${rec.recommended_model_id}`,
      rationale: rec.rationale,
      savingsUsd: rec.monthly_savings_usd,
      confidence: rec.score,
      model: rec.recommended_model_id,
    });
    for (const r of rec.runners_up ?? []) {
      rows.push({
        id: `run-${r.provider}-${r.model_id}`,
        kind: "runner_up",
        title: `${r.provider}/${r.model_id}`,
        rationale: r.rationale,
        savingsUsd: null,
        confidence: r.score,
        model: r.model_id,
      });
    }
  }
  rows.push({
    id: "cache-hint",
    kind: "cache",
    title: "Enable prompt caching",
    rationale:
      "Cache stable system prompts and tool schemas to cut repeat input spend.",
    savingsUsd: rec.monthly_savings_usd != null
      ? rec.monthly_savings_usd * 0.15
      : null,
    confidence: 0.6,
  });
  if (modelFilter) {
    const q = modelFilter.toLowerCase();
    return rows.filter(
      (r) =>
        r.model?.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q),
    );
  }
  return rows;
}

export function AdvisorTab({ pastHours, agentId, model, canAct }: Props) {
  const t = useTranslations("cost");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const hours = costWindowHours(pastHours);
  const days = costWindowDays(hours);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useOrgQuery(
    ["cost", "advisor", orgId, days, model ?? null] as const,
    orgId,
    async () => {
      const current = model
        ? {
            provider: model.includes("/")
              ? model.split("/")[0]!
              : "openai",
            model_id: model.includes("/")
              ? model.split("/").slice(1).join("/")
              : model,
          }
        : { provider: "openai", model_id: "gpt-4o" };

      return modelAdvisorApi.recommend(orgId!, {
        mode: "switch",
        candidates: [...DEFAULT_CANDIDATES],
        current,
        window_days: days,
      });
    },
  );

  const rows = useMemo(
    () => (query.data ? buildRows(query.data, model) : []),
    [query.data, model],
  );

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  if (!currentOrg) return <NoOrgState feature={t("advisor.title")} />;

  const tracesHref = agentId
    ? `/traces?agentId=${encodeURIComponent(agentId)}`
    : "/traces";
  const improveHref = agentId
    ? `/improve?tab=queue&agentId=${encodeURIComponent(agentId)}`
    : "/improve?tab=plans";
  const evalsHref = selected?.model
    ? `/evals?tab=playgrounds&model=${encodeURIComponent(selected.model)}`
    : "/evals?tab=playgrounds";

  return (
    <QueryState
      loading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={() => void query.refetch()}
      errorTitle={t("errors.loadAdvisor")}
      isEmpty={() => false}
      loadingSlot={
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      }
      emptySlot={
        <EmptyState
          icon={Lightbulb}
          title={t("advisor.emptyTitle")}
          description={t("advisor.emptyBody")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/agents/connect">{t("empty.connect")}</Link>
            </Button>
          }
        />
      }
    >
      {() => (
        <div className="space-y-4" data-testid="cost-advisor-panel">
          <Panel tone="inset" padding="md">
            <ul className="divide-y divide-[var(--border-subtle)]" role="listbox">
              {rows.map((row) => {
                const isSelected = selected?.id === row.id;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={cn(
                        "flex w-full flex-col gap-1 px-2 py-3 text-left transition-colors",
                        isSelected
                          ? "bg-[var(--accent-faint)]/50"
                          : "hover:bg-[var(--bg-secondary)]",
                      )}
                      onClick={() => setSelectedId(row.id)}
                      data-testid="cost-advisor-row"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-[var(--text-primary)]">
                          {row.title}
                        </span>
                        <span className="text-xs tabular-nums text-[var(--text-muted)]">
                          {row.savingsUsd != null
                            ? t("advisor.savings", {
                                amount: fmtUsd(row.savingsUsd),
                              })
                            : t("advisor.noSavings")}
                          {" · "}
                          {t("advisor.confidence", {
                            pct: (row.confidence * 100).toFixed(0),
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--text-secondary)]">
                        {row.rationale}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>

          {selected ? (
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="cost-advisor-actions"
            >
              {canAct ? (
                <>
                  <Button asChild size="sm">
                    <Link href={improveHref}>{t("advisor.createPlan")}</Link>
                  </Button>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={evalsHref}>{t("advisor.tryEvals")}</Link>
                  </Button>
                </>
              ) : (
                <>
                  <Button asChild size="sm">
                    <Link href={tracesHref}>{t("advisor.openTraces")}</Link>
                  </Button>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={evalsHref}>{t("advisor.tryEvals")}</Link>
                  </Button>
                </>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title={t("advisor.selectTitle")}
              description={t("advisor.selectBody")}
              size="sm"
            />
          )}
        </div>
      )}
    </QueryState>
  );
}
