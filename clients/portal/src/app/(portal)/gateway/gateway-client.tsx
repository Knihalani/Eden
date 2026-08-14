"use client";

import {
  useEffect,
  useMemo,
  useState,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { PageHeader } from "@/components/ds/primitives";
import { formatUsd } from "@/lib/format";
import { MetricCell } from "@/lab/lab-metric-cell";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { gatewayApi } from "@/lib/api/gateway";
import { GATEWAY_URL } from "@/lib/constants";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { SHELL_QUERY } from "@/lib/portal-query";
import { downloadCsv } from "@/lib/export";
import { useLabToast } from "@/lab/lab-toast";
import { cn } from "@/lib/utils";

const chartFallback = (
  <p className="type-meta px-2 py-8 text-center">Loading charts…</p>
);

const GatewaySpendChart = dynamic(
  () =>
    import("./gateway-charts").then((m) => ({ default: m.GatewaySpendChart })),
  { ssr: false, loading: () => chartFallback },
);

const GatewayBreakdownCharts = dynamic(
  () =>
    import("./gateway-charts").then((m) => ({
      default: m.GatewayBreakdownCharts,
    })),
  { ssr: false, loading: () => chartFallback },
);

const WINDOW_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;



function formatTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatRate(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  const r = Number(rate);
  const normalized = r > 1 ? r : r * 100;
  return `${normalized.toFixed(1)}%`;
}

function shortDay(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type BreakdownRow = {
  key: string;
  cost_usd: number | null;
  events: number;
  tokens: number;
};

function normalizeBreakdown(
  rows: Array<{ key?: string; cost_usd: number; events: number; tokens: number }> | undefined,
): BreakdownRow[] {
  return (rows ?? [])
    .map((r) => {
      const raw = r.cost_usd == null ? NaN : Number(r.cost_usd);
      return {
        key: String(r.key || "unknown"),
        cost_usd: Number.isFinite(raw) ? raw : null,
        events: Number(r.events) || 0,
        tokens: Number(r.tokens) || 0,
      };
    })
    .filter((r) => r.key)
    .sort((a, b) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1))
    .slice(0, 12);
}

function BreakdownTable({
  title,
  rows,
  empty,
  onExport,
}: {
  title: string;
  rows: BreakdownRow[];
  empty: string;
  onExport?: () => void;
}) {
  const maxCost = Math.max(
    1,
    ...rows.map((r) => (r.cost_usd != null && Number.isFinite(r.cost_usd) ? r.cost_usd : 0)),
  );
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        {title ? <h2 className="type-ui">{title}</h2> : null}
        {onExport && rows.length > 0 ? (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm !rounded-none"
            onClick={onExport}
          >
            CSV
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="type-meta px-1">{empty}</p>
      ) : (
        <div className="overflow-x-auto border border-[var(--line)]">
          <table className="w-full min-w-[28rem] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] type-meta">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Tokens</th>
                <th className="px-3 py-2 font-medium">Events</th>
                <th className="px-3 py-2 font-medium w-[40%]">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-[var(--line)] last:border-0"
                >
                  <td className="type-ui px-3 py-2 truncate max-w-[14rem]">
                    {row.key}
                  </td>
                  <td className="type-meta px-3 py-2 tabular-nums">
                    {formatUsd(row.cost_usd)}
                  </td>
                  <td className="type-meta px-3 py-2 tabular-nums">
                    {formatTokens(row.tokens)}
                  </td>
                  <td className="type-meta px-3 py-2 tabular-nums">
                    {row.events}
                  </td>
                  <td className="px-3 py-2">
                    <div className="h-1.5 w-full bg-[var(--fill-quiet)]">
                      <div
                        className="h-1.5 bg-[var(--text)]"
                        style={{
                          width:
                            row.cost_usd == null
                              ? "0%"
                              : `${Math.max(2, (row.cost_usd / maxCost) * 100)}%`,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function GatewayClient() {
  const { currentOrg } = useOrg();
  const { pushToast } = useLabToast();
  const orgId = currentOrg?.id ?? null;
  const [windowIdx, setWindowIdx] = useState(0);
  const activeWindow = WINDOW_OPTIONS[windowIdx] ?? WINDOW_OPTIONS[0];

  const [chartsReady, setChartsReady] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setChartsReady(true), 0);
    return () => window.clearTimeout(id);
  }, []);

  const overview = useOrgQuery(
    queryKeys.gateway.overview(orgId, activeWindow.hours),
    orgId,
    () => gatewayApi.overview(orgId!, activeWindow.hours),
    { ...SHELL_QUERY, staleTime: 60_000 },
  );

  const data = overview.data?.data;
  const byModel = useMemo(
    () => normalizeBreakdown(data?.by_model),
    [data?.by_model],
  );
  const byFeature = useMemo(
    () => normalizeBreakdown(data?.by_feature),
    [data?.by_feature],
  );
  const byAgent = useMemo(
    () => normalizeBreakdown(data?.by_agent),
    [data?.by_agent],
  );

  const series = useMemo(() => {
    return (data?.by_day ?? []).map((d) => {
      const day = String(d.day ?? "");
      const rawCost = d.cost_usd == null ? NaN : Number(d.cost_usd);
      return {
        day,
        label: shortDay(day),
        cost_usd: Number.isFinite(rawCost) ? rawCost : null,
        tokens: Number(d.tokens) || 0,
        input_tokens: Number(d.input_tokens) || 0,
        output_tokens: Number(d.output_tokens) || 0,
        events: Number(d.events) || 0,
      };
    });
  }, [data?.by_day]);


  const registry = data?.models ?? [];
  const providersHealth = data?.providers ?? [];

  const cacheView = useMemo(() => {
    const raw = data?.cache;
    if (!raw) return null;
    if (typeof raw.l1_hit_rate === "number" || typeof raw.l2_hit_rate === "number") {
      const l1Hits = Number(raw.l1_hits) || 0;
      const l1Miss = Number(raw.l1_misses) || 0;
      const l2Hits = Number(raw.l2_hits) || 0;
      const l2Miss = Number(raw.l2_misses) || 0;
      return {
        hitRate: Number(raw.l1_hit_rate) || Number(raw.l2_hit_rate) || 0,
        detail: `L1 ${formatRate(Number(raw.l1_hit_rate))} · L2 ${formatRate(Number(raw.l2_hit_rate))}`,
        hits: l1Hits + l2Hits,
        misses: l1Miss + l2Miss,
      };
    }
    return {
      hitRate: Number(raw.hit_rate) || 0,
      detail: null as string | null,
      hits: Number(raw.hits) || 0,
      misses: Number(raw.misses) || 0,
    };
  }, [data?.cache]);

  const loading = overview.isLoading && !overview.data;
  const hardError = overview.isError && !overview.data;

  const exportAllCsv = () => {
    if (!data) {
      pushToast({ title: "Nothing to export yet", tone: "default" });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const rows = [
      ...byModel.map((r) => ({
        dimension: "model",
        name: r.key,
        cost_usd: r.cost_usd,
        tokens: r.tokens,
        events: r.events,
      })),
      ...byFeature.map((r) => ({
        dimension: "feature",
        name: r.key,
        cost_usd: r.cost_usd,
        tokens: r.tokens,
        events: r.events,
      })),
      ...byAgent.map((r) => ({
        dimension: "agent",
        name: r.key,
        cost_usd: r.cost_usd,
        tokens: r.tokens,
        events: r.events,
      })),
      ...series.map((r) => ({
        dimension: "day",
        name: r.day,
        cost_usd: r.cost_usd,
        tokens: r.tokens,
        events: r.events,
      })),
    ];
    if (rows.length === 0) {
      pushToast({ title: "Nothing to export yet", tone: "default" });
      return;
    }
    downloadCsv(`eden-gateway-${activeWindow.label}-${stamp}.csv`, rows);
  };


  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Gateway"
        message="Select a workspace to view gateway usage."
      />
    );
  }

  if (hardError) {
    return (
      <div className="ds-page">
        <PageHeader title="Gateway" />
        <QueryErrorPanel
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="ds-page">
        <PageHeader title="Gateway" />
        <QueryLoadingPanel label="Loading gateway usage…" />
      </div>
    );
  }

  const deltaPct = data?.delta_pct;
  const deltaLabel =
    deltaPct == null
      ? "vs prior window"
      : `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}% vs prior`;

  return (
    <div className="ds-page">
      <PageHeader
        title="Gateway"
        meta={
          <span className="type-meta">
            Spend, tokens, and models · {GATEWAY_URL}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="tablist"
              aria-label="Window"
              className="flex gap-1 border border-[var(--line)] p-0.5"
            >
              {WINDOW_OPTIONS.map((opt, i) => (
                <button
                  key={opt.label}
                  type="button"
                  role="tab"
                  aria-selected={i === windowIdx}
                  className={cn(
                    "ds-btn ds-btn-sm !rounded-none",
                    i === windowIdx ? "ds-btn-primary" : "ds-btn-ghost",
                  )}
                  onClick={() => setWindowIdx(i)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ds-btn ds-btn-outline ds-btn-sm"
              onClick={exportAllCsv}
              disabled={!data}
            >
              Export CSV
            </button>
            <Link
              href="/settings?mode=keys"
              className="ds-btn ds-btn-outline ds-btn-sm"
            >
              API keys
            </Link>
          </div>
        }
      />

      {/* First viewport: 2–3 KPIs + one primary chart. */}
      <div className="lab-metric-strip shrink-0">
        <MetricCell
          label={`Spend (${activeWindow.label})`}
          value={formatUsd(data?.total_cost_usd)}
          hint={deltaLabel}
        />
        <MetricCell
          label="Requests"
          value={String(data?.events ?? 0)}
          hint={`${data?.untagged_events ?? 0} untagged`}
        />
        <MetricCell
          label="Tokens"
          value={formatTokens(data?.total_tokens)}
          hint={`${formatTokens(data?.input_tokens)} in · ${formatTokens(data?.output_tokens)} out`}
        />
      </div>

      <div className="flex flex-col gap-8 px-5 py-6 sm:px-6">
        {chartsReady ? (
          <GatewaySpendChart
            series={series}
            windowLabel={activeWindow.label}
            emptySlot={
              <div className="px-2 py-8 text-center">
                <p className="type-meta">No spend in this window yet.</p>
                <p className="type-body mt-2 text-[var(--text-secondary)]">
                  Point your client at{" "}
                  <code className="type-meta">{GATEWAY_URL}</code> with an Eden
                  API key, then send traffic.
                </p>
                <Link
                  href="/settings?mode=keys"
                  className="ds-btn ds-btn-outline ds-btn-sm mt-3"
                >
                  API keys
                </Link>
              </div>
            }
          />
        ) : (
          chartFallback
        )}

        {/* Secondary: breakdowns + extra charts below the fold. */}
        <details
          className="group border border-[var(--line)] open:pb-0"
          onToggle={(e) =>
            setBreakdownOpen((e.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary className="cursor-pointer list-none px-4 py-3 type-ui marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="flex items-center justify-between gap-2">
              Breakdown &amp; models
              <span className="type-meta group-open:hidden">
                Show {registry.length + byModel.length}
              </span>
              <span className="type-meta hidden group-open:inline">Hide</span>
            </span>
          </summary>
          <div className="flex flex-col gap-8 border-t border-[var(--line)] px-4 py-6 sm:px-5">
            <div className="lab-metric-strip -mx-4 border-y border-[var(--line)] sm:-mx-5">
              <MetricCell
                label="Cache savings"
                value={formatUsd(data?.cache_savings_usd)}
                hint="Prompt-cache $ saved"
              />
              <MetricCell
                label="Models"
                value={String(registry.length)}
                hint={
                  registry.filter((m) => m.enabled).length
                    ? `${registry.filter((m) => m.enabled).length} enabled`
                    : "No models yet"
                }
              />
              {cacheView ? (
                <MetricCell
                  label="Cache hit rate"
                  value={formatRate(cacheView.hitRate)}
                  hint={
                    cacheView.detail ??
                    `${cacheView.hits} hits · ${cacheView.misses} miss`
                  }
                />
              ) : null}
            </div>

            {breakdownOpen ? (
              <GatewayBreakdownCharts
                series={series}
                byModel={byModel}
                windowLabel={activeWindow.label}
              />
            ) : null}

            <div className="grid gap-8 lg:grid-cols-2">
              <BreakdownTable
                title="By feature"
                rows={byFeature}
                empty="No feature-tagged spend yet."
                onExport={() =>
                  downloadCsv(
                    `eden-gateway-features-${activeWindow.label}.csv`,
                    byFeature,
                  )
                }
              />
              <BreakdownTable
                title="By agent"
                rows={byAgent}
                empty="No agent-tagged spend yet."
                onExport={() =>
                  downloadCsv(
                    `eden-gateway-agents-${activeWindow.label}.csv`,
                    byAgent,
                  )
                }
              />
            </div>

            <section>
              <h2 className="type-ui mb-3">Configured gateway models</h2>
              {registry.length === 0 ? (
                <p className="type-meta">
                  No models registered. Add upstream models via the gateway
                  models API, then route clients through Eden.
                </p>
              ) : (
                <div className="overflow-x-auto border border-[var(--line)]">
                  <table className="w-full min-w-[32rem] text-left">
                    <thead>
                      <tr className="border-b border-[var(--line)] type-meta">
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Provider</th>
                        <th className="px-3 py-2 font-medium">Upstream</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Priority</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registry.map((m) => (
                        <tr
                          key={m.model_id}
                          className="border-b border-[var(--line)] last:border-0"
                        >
                          <td className="type-ui px-3 py-2">{m.name}</td>
                          <td className="type-meta px-3 py-2">{m.provider}</td>
                          <td className="type-meta px-3 py-2">
                            {m.upstream_model}
                          </td>
                          <td className="type-meta px-3 py-2">
                            {m.enabled ? "Enabled" : "Disabled"}
                          </td>
                          <td className="type-meta px-3 py-2 tabular-nums">
                            {m.routing_priority}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {providersHealth.length > 0 ? (
              <section>
                <h2 className="type-ui mb-3">Provider health (live process)</h2>
                <div className="overflow-x-auto border border-[var(--line)]">
                  <table className="w-full min-w-[24rem] text-left">
                    <thead>
                      <tr className="border-b border-[var(--line)] type-meta">
                        <th className="px-3 py-2 font-medium">Provider</th>
                        <th className="px-3 py-2 font-medium">Healthy</th>
                        <th className="px-3 py-2 font-medium">Avg latency</th>
                        <th className="px-3 py-2 font-medium">Error rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providersHealth.map((p) => (
                        <tr
                          key={p.provider}
                          className="border-b border-[var(--line)] last:border-0"
                        >
                          <td className="type-ui px-3 py-2">{p.provider}</td>
                          <td className="type-meta px-3 py-2">
                            {p.healthy ? "Yes" : "No"}
                          </td>
                          <td className="type-meta px-3 py-2 tabular-nums">
                            {Math.round(p.avg_latency_ms ?? 0)} ms
                          </td>
                          <td className="type-meta px-3 py-2 tabular-nums">
                            {formatRate(p.error_rate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="type-meta mt-2">
                  Live process view — may reset on deploy. Durable spend is
                  above.
                </p>
              </section>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}
