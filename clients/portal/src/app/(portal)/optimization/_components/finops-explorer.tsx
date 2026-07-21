"use client";

/**
 * F60 FinOps explorer — model / agent / session / feature / day breakdown,
 * compare_previous, cache savings, CSV export. Customer-facing only
 * (no Eden COGS cockpit).
 *
 * Helicone-style cost grouping: dimension drill + table is the primary
 * interaction; KPIs are a calm secondary strip (not a card wall).
 */

import { useMemo, useState } from "react";
import { Download, Loader2, Wallet } from "lucide-react";

import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  featureGatedErrorCopy,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";
import { cn } from "@/lib/utils";
import { CostImproveCrossLink } from "./cost-improve-cross-link";

type DimRow = {
  key?: string;
  day?: string;
  cost_usd: number;
  events: number;
  tokens: number;
};

type ExplorerData = {
  total_cost_usd: number;
  previous_cost_usd: number;
  delta_usd: number;
  delta_pct: number | null;
  by_feature: DimRow[];
  by_model: DimRow[];
  by_agent: DimRow[];
  by_session: DimRow[];
  by_day: DimRow[];
  untagged_events: number;
  cache_savings_usd: number;
  classifier_savings_usd?: number;
  window_hours: number;
};

function formatUsd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${n.toFixed(4)}`;
}

function KpiCell({
  label,
  value,
  meta,
  emphasize,
}: {
  label: string;
  value: string;
  meta: string;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-2xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums tracking-tight",
          emphasize ? "text-[var(--terminal)]" : "text-[var(--text-primary)]",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-[var(--text-muted)]">{meta}</p>
    </div>
  );
}

export default function FinOpsExplorer() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [hours, setHours] = useState(24);
  const [dim, setDim] = useState<"feature" | "model" | "agent" | "session" | "day">(
    "feature",
  );

  const { data, isLoading, error, refetch } = useOrgQuery(
    queryKeys.finops.explorer(orgId, hours),
    orgId,
    async () => {
      const res = await api.finopsExplorer(orgId!, hours);
      return res.data as ExplorerData;
    },
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const map = {
      feature: data.by_feature,
      model: data.by_model,
      agent: data.by_agent,
      session: data.by_session,
      day: data.by_day,
    } as const;
    return map[dim] ?? [];
  }, [data, dim]);

  const evolvePromoteSpend = useMemo(() => {
    const feats = data?.by_feature ?? [];
    const evolution = feats.find((r) => (r.key || "").toLowerCase() === "evolution");
    const promote = feats.find((r) => (r.key || "").toLowerCase() === "promote");
    const investigator = feats.find(
      (r) => (r.key || "").toLowerCase() === "signal_investigator",
    );
    const classifier = feats.find(
      (r) => (r.key || "").toLowerCase() === "signal_classifier",
    );
    return {
      evolution_usd: evolution?.cost_usd ?? 0,
      promote_usd: promote?.cost_usd ?? 0,
      evolution_events: evolution?.events ?? 0,
      promote_events: promote?.events ?? 0,
      investigator_usd: investigator?.cost_usd ?? 0,
      classifier_events: classifier?.events ?? 0,
    };
  }, [data]);

  if (!currentOrg) {
    return <NoOrgState feature="Cost explorer" />;
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load FinOps explorer");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          isRetryableIntelligenceError(error) ? (
            <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="finops-cost-hierarchy">
      {/* Toolbar: window + export — Helicone-style dimension controls live with the table */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Window"
          className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
        >
          {[24, 168, 720].map((h) => (
            <Button
              key={h}
              type="button"
              size="sm"
              variant={hours === h ? "default" : "ghost"}
              onClick={() => setHours(h)}
              aria-pressed={hours === h}
            >
              {h === 24 ? "24h" : h === 168 ? "7d" : "30d"}
            </Button>
          ))}
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/proxy/orgs/${orgId}/finops/export?window_hours=${hours}&fmt=csv`}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </a>
        </Button>
      </div>

      {/* Secondary KPI strip — flat, not a 4-card wall */}
      <Panel tone="flat" padding="md" aria-label="Spend summary">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCell
            label="Spend"
            value={formatUsd(data?.total_cost_usd ?? 0)}
            meta={
              data?.delta_pct != null
                ? `${data.delta_pct >= 0 ? "+" : ""}${data.delta_pct}% vs prior`
                : "vs prior window"
            }
            emphasize
          />
          <KpiCell
            label="Prior window"
            value={formatUsd(data?.previous_cost_usd ?? 0)}
            meta="compare_previous"
          />
          <KpiCell
            label="Cache savings"
            value={formatUsd(data?.cache_savings_usd ?? 0)}
            meta="Gateway prompt-cache"
          />
          <KpiCell
            label="Untagged exits"
            value={String(data?.untagged_events ?? 0)}
            meta="feature=unknown"
          />
        </div>
      </Panel>

      {data?.delta_pct != null && data.delta_pct >= 25 ? (
        <CostImproveCrossLink reason="Spend up sharply vs prior window — open Improve to act on cost plans." />
      ) : null}

      {/* Secondary loop spend — compact, not competing cards */}
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="evolve-promote-spend"
      >
        <Panel tone="subtle" padding="sm">
          <p className="text-xs text-[var(--text-muted)]">Evolution</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
            {formatUsd(evolvePromoteSpend.evolution_usd)}
          </p>
          <p className="text-2xs text-[var(--text-muted)]">
            {evolvePromoteSpend.evolution_events} events
          </p>
        </Panel>
        <Panel tone="subtle" padding="sm">
          <p className="text-xs text-[var(--text-muted)]">Promote</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
            {formatUsd(evolvePromoteSpend.promote_usd)}
          </p>
          <p className="text-2xs text-[var(--text-muted)]">
            {evolvePromoteSpend.promote_events} events
          </p>
        </Panel>
        <Panel tone="subtle" padding="sm" data-testid="f34-classifier-savings">
          <p className="text-xs text-[var(--text-muted)]">Classifier savings</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--terminal)]">
            {formatUsd(data?.classifier_savings_usd ?? 0)}
          </p>
          <p className="text-2xs text-[var(--text-muted)]">
            {evolvePromoteSpend.classifier_events} classifier events
          </p>
        </Panel>
        <Panel tone="subtle" padding="sm">
          <p className="text-xs text-[var(--text-muted)]">Investigator</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
            {formatUsd(evolvePromoteSpend.investigator_usd)}
          </p>
          <p className="text-2xs text-[var(--text-muted)]">when classifiers miss</p>
        </Panel>
      </div>

      {/* Primary interaction — dimension group + breakdown table */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Cost breakdown</h3>
            <p className="text-xs text-[var(--text-muted)]">
              Group spend by feature, model, agent, session, or day
            </p>
          </div>
          <div
            role="group"
            aria-label="Dimension"
            className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
          >
            {(["feature", "model", "agent", "session", "day"] as const).map((d) => (
              <Button
                key={d}
                type="button"
                size="sm"
                variant={dim === d ? "default" : "ghost"}
                onClick={() => setDim(d)}
                aria-pressed={dim === d}
                className="capitalize"
              >
                {d}
              </Button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No cost events yet"
            description="Spend appears after tagged LLM calls write to the customer cost ledger."
            size="md"
          />
        ) : (
          <DataTable
            columns={[
              {
                key: "key",
                header: dim === "day" ? "Day" : dim,
                cell: (r) => {
                  const row = r as DimRow;
                  return (
                    <span className="font-mono text-xs">
                      {dim === "day" ? row.day ?? "—" : row.key ?? "—"}
                    </span>
                  );
                },
                sortable: true,
              },
              {
                key: "cost_usd",
                header: "Cost",
                align: "right",
                cell: (r) => formatUsd((r as DimRow).cost_usd),
                sortable: true,
              },
              {
                key: "events",
                header: "Events",
                align: "right",
                cell: (r) => String((r as DimRow).events),
                sortable: true,
              },
              {
                key: "tokens",
                header: "Tokens",
                align: "right",
                cell: (r) => String((r as DimRow).tokens),
                sortable: true,
              },
            ]}
            rows={rows}
          />
        )}
      </div>
    </div>
  );
}
