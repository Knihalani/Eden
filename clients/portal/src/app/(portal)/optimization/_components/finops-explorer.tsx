"use client";

/**
 * F60 FinOps explorer — model / agent / session / feature / day breakdown,
 * compare_previous, cache savings, CSV export. Customer-facing only
 * (no Eden COGS cockpit).
 */

import { useMemo, useState } from "react";
import { Download, Loader2, Wallet, Calendar, PiggyBank, AlertTriangle } from "lucide-react";

import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { StatCard } from "@/components/ui/stat-card";
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

function MetricTile({
  title,
  description,
  value,
  meta,
  emphasize,
}: {
  title: string;
  description: string;
  value: string;
  meta: string;
  emphasize?: boolean;
}) {
  return (
    <Panel tone="flat" padding="md">
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
      <p
        className={cn(
          "mt-2 text-lg font-semibold tabular-nums",
          emphasize ? "text-[var(--terminal)]" : "text-[var(--text-primary)]",
        )}
      >
        {value}
      </p>
      <p className="text-xs text-[var(--text-muted)]">{meta}</p>
    </Panel>
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Window"
          className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-0.5"
        >
          {[24, 168, 720].map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHours(h)}
              aria-pressed={hours === h}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium",
                hours === h
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {h === 24 ? "24h" : h === 168 ? "7d" : "30d"}
            </button>
          ))}
        </div>
        <a
          href={`/api/proxy/orgs/${orgId}/finops/export?window_hours=${hours}&fmt=csv`}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </a>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Spend"
          value={formatUsd(data?.total_cost_usd ?? 0)}
          subtitle={
            data?.delta_pct != null
              ? `${data.delta_pct >= 0 ? "+" : ""}${data.delta_pct}% vs prior`
              : "vs prior window"
          }
          icon={Wallet}
          accent="warning"
        />
        <StatCard
          title="Prior window"
          value={formatUsd(data?.previous_cost_usd ?? 0)}
          subtitle="compare_previous"
          icon={Calendar}
          accent="accent"
        />
        <StatCard
          title="Cache savings"
          value={formatUsd(data?.cache_savings_usd ?? 0)}
          subtitle="Gateway prompt-cache"
          icon={PiggyBank}
          accent="terminal"
        />
        <StatCard
          title="Untagged LLM exits"
          value={String(data?.untagged_events ?? 0)}
          subtitle="feature=unknown"
          icon={AlertTriangle}
          accent={(data?.untagged_events ?? 0) > 0 ? "warning" : "accent"}
        />
      </div>

      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        data-testid="evolve-promote-spend"
      >
        <MetricTile
          title="Evolution spend"
          description="feature=evolution (N18 loop)"
          value={formatUsd(evolvePromoteSpend.evolution_usd)}
          meta={`${evolvePromoteSpend.evolution_events} events`}
        />
        <MetricTile
          title="Promote spend"
          description="feature=promote (EvidenceGate)"
          value={formatUsd(evolvePromoteSpend.promote_usd)}
          meta={`${evolvePromoteSpend.promote_events} events`}
        />
      </div>

      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        data-testid="f34-classifier-savings"
      >
        <MetricTile
          title="Classifier savings"
          description="F34 estimated $ avoided vs F06 investigator"
          value={formatUsd(data?.classifier_savings_usd ?? 0)}
          meta={`${evolvePromoteSpend.classifier_events} classifier events`}
          emphasize
        />
        <MetricTile
          title="Investigator spend"
          description="feature=signal_investigator"
          value={formatUsd(evolvePromoteSpend.investigator_usd)}
          meta="Metered when classifiers do not skip F06"
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Cost breakdown</h3>
            <p className="text-xs text-[var(--text-muted)]">
              Drill by feature, model, agent, session, or day
            </p>
          </div>
          <div
            role="group"
            aria-label="Dimension"
            className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-0.5"
          >
            {(["feature", "model", "agent", "session", "day"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDim(d)}
                aria-pressed={dim === d}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium capitalize",
                  dim === d
                    ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                {d}
              </button>
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
