"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  Loader2,
  TrendingDown,
  Cpu,
  Database,
  Wallet,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Zap,
  ArrowUpRight,
  RefreshCw,
  BarChart3,
  PieChart,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RePieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";

const TIER_COLORS: Record<string, string> = {
  t1: "var(--terminal)",
  t2: "var(--accent)",
  t3: "var(--warning)",
  t4: "var(--error)",
};

const TIER_LABELS: Record<string, string> = {
  t1: "T1 — Fast/Cheap",
  t2: "T2 — Standard",
  t3: "T3 — Expert",
  t4: "T4 — Custom",
};

export default function OptimizationPage() {
  const { currentOrg } = useOrg();
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [invalidating, setInvalidating] = useState(false);

  useEffect(() => {
    if (!currentOrg) return;
    loadData();
  }, [currentOrg, days]);

  async function loadData() {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getOptimizationOverview(currentOrg.id, days);
      setOverview(data);
    } catch (e) {
      console.error("Failed to load optimization data:", e);
      setError("Could not load optimization data. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleInvalidateCache() {
    if (!currentOrg) return;
    setInvalidating(true);
    try {
      await api.invalidateOptimizationCache(currentOrg.id, "all");
      await loadData();
    } catch (e) {
      console.error("Failed to invalidate cache:", e);
      setError("Cache invalidation failed. Please try again.");
    } finally {
      setInvalidating(false);
    }
  }

  const routing = overview?.routing;
  const cache = overview?.cache;
  const costs = overview?.costs;
  const budget = overview?.budget;
  const savings = overview?.savings;

  const tierChartData = useMemo(() => {
    if (!routing?.calls_by_tier) return [];
    return Object.entries(routing.calls_by_tier).map(([tier, count]) => ({
      name: TIER_LABELS[tier] || tier,
      value: count as number,
      color: TIER_COLORS[tier] || "var(--text-muted)",
    }));
  }, [routing]);

  const costByTierData = useMemo(() => {
    if (!costs?.by_tier) return [];
    return Object.entries(costs.by_tier).map(([tier, cost]) => ({
      name: TIER_LABELS[tier] || tier,
      value: cost as number,
      color: TIER_COLORS[tier] || "var(--text-muted)",
    }));
  }, [costs]);

  const costByNodeData = useMemo(() => {
    if (!costs?.by_node) return [];
    return Object.entries(costs.by_node)
      .map(([node, cost]) => ({ name: node, value: cost as number }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [costs]);

  const budgetStatusColor = useMemo(() => {
    if (!budget) return "text-[var(--text-muted)]";
    switch (budget.status) {
      case "ok": return "text-[var(--success)]";
      case "soft_limit": return "text-[var(--warning)]";
      case "hard_limit": return "text-[var(--error)]";
      default: return "text-[var(--text-muted)]";
    }
  }, [budget]);

  const BudgetStatusIcon = useMemo(() => {
    if (!budget) return CheckCircle2;
    switch (budget.status) {
      case "ok": return CheckCircle2;
      case "soft_limit": return AlertTriangle;
      case "hard_limit": return AlertTriangle;
      default: return CheckCircle2;
    }
  }, [budget]);

  const budgetStatusLabel = useMemo(() => {
    if (!budget) return "Unknown";
    switch (budget.status) {
      case "ok": return "Within Budget";
      case "soft_limit": return "Soft Limit Reached";
      case "hard_limit": return "Hard Limit Exceeded";
      default: return budget.status;
    }
  }, [budget]);

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={TrendingDown}
        feature="Cost Optimization"
        description="Model routing, caching, and cost efficiency metrics need completed jobs to compare against."
      />
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto page-enter">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">Cost Optimization</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Model routing, caching, and cost efficiency metrics
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={handleInvalidateCache}
            disabled={invalidating}
            className="flex items-center gap-2"
          >
            {invalidating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Clear Cache
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg border border-[var(--error)]/20 bg-[var(--error-bg)] text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {/* Budget Status Banner */}
      {budget && (
        <div className={cn(
          "mb-6 p-4 rounded-lg border flex items-center gap-3",
          budget.status === "ok" && "border-[var(--success)]/20 bg-[var(--success-bg)]",
          budget.status === "soft_limit" && "border-[var(--warning)]/20 bg-[var(--warning-bg)]",
          budget.status === "hard_limit" && "border-[var(--error)]/20 bg-[var(--error-bg)]",
        )}>
          <BudgetStatusIcon className={cn("w-5 h-5", budgetStatusColor)} />
          <div className="flex-1">
            <p className={cn("text-sm font-semibold", budgetStatusColor)}>
              {budgetStatusLabel}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              ${(budget.current_month_spend_cents / 100).toFixed(2)} / ${(budget.hard_limit_cents / 100).toFixed(2)} spent this month ({budget.utilization_pct}%)
            </p>
          </div>
          {budget.status !== "ok" && (
            <Link href="/settings" className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]">
              Manage plan →
            </Link>
          )}
        </div>
      )}

      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          label="Total Calls"
          value={routing?.total_calls?.toLocaleString() ?? "—"}
          subtitle={`${routing?.fallbacks ?? 0} fallbacks`}
          icon={Layers}
          accent="neutral"
          isLoading={loading}
        />
        <StatCard
          label="Cache Hit Rate"
          value={cache ? `${((cache.l1_hit_rate + cache.l2_hit_rate) / 2 * 100).toFixed(1)}%` : "—"}
          subtitle={`L1: ${((cache?.l1_hit_rate ?? 0) * 100).toFixed(0)}% · L2: ${((cache?.l2_hit_rate ?? 0) * 100).toFixed(0)}%`}
          icon={Database}
          accent="accent"
          isLoading={loading}
        />
        <StatCard
          label="Cost Saved"
          value={savings ? `$${(savings.estimated_cost_saved_cents / 100).toFixed(2)}` : "—"}
          subtitle={`${(savings?.tokens_saved ?? 0).toLocaleString()} tokens`}
          icon={TrendingDown}
          accent="terminal"
          isLoading={loading}
        />
        <StatCard
          label="Total Spend"
          value={costs ? `$${costs.total_cost_usd.toFixed(2)}` : "—"}
          subtitle={`${costs?.events_count ?? 0} events`}
          icon={Wallet}
          accent="warning"
          isLoading={loading}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Tier Distribution */}
        <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Model Tier Distribution</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Calls routed per tier</p>
            </div>
            <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          {loading ? (
            <div className="h-48 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : tierChartData.length === 0 ? (
            <EmptyState
              icon={TrendingDown}
              title="No routing data yet"
              description="Run LLM calls to see how Eden distributes them across model tiers."
              size="sm"
            />
          ) : (
            <ResponsiveContainer width="100%" height={192}>
              <BarChart data={tierChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "6px",
                    fontSize: "12px",
                    boxShadow: "var(--shadow-md)",
                  }}
                  formatter={(value) => [`${value} calls`, "Count"]}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {tierChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Cost by Tier */}
        <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Cost by Tier</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Spending distribution</p>
            </div>
            <PieChart className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          {loading ? (
            <div className="h-48 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : costByTierData.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No cost data yet"
              description="Cost tracking starts as soon as your team makes LLM calls through Eden."
              size="sm"
            />
          ) : (
            <ResponsiveContainer width="100%" height={192}>
              <RePieChart>
                <Pie
                  data={costByTierData}
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {costByTierData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Legend
                  formatter={(value) => <span className="text-xs text-[var(--text-muted)]">{value}</span>}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "6px",
                    fontSize: "12px",
                    boxShadow: "var(--shadow-md)",
                  }}
                  formatter={(value: number) => [`$${(value / 100).toFixed(4)}`, "Cost"]}
                />
              </RePieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Cost by Pipeline Node */}
        <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Cost by Pipeline Node</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Top spenders</p>
            </div>
            <Zap className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : costByNodeData.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No pipeline cost data yet"
              description="Cost attribution per pipeline node appears here as jobs complete."
              size="sm"
            />
          ) : (
            <div className="space-y-3">
              {costByNodeData.map((node) => (
                <div key={node.name} className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text-muted)] w-28 truncate">{node.name}</span>
                  <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent)] rounded-full transition-all"
                      style={{
                        width: `${costByNodeData[0]?.value ? (node.value / costByNodeData[0].value) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs font-medium text-[var(--text-primary)] w-16 text-right">
                    ${(node.value / 100).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Routing Efficiency */}
        <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Routing Efficiency</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Classifier & validation stats</p>
            </div>
            <Cpu className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : !routing ? (
            <EmptyState
              icon={TrendingDown}
              title="No routing decisions yet"
              description="The routing table will fill out as Eden handles LLM calls."
              size="sm"
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-tertiary)]">
                <span className="text-sm text-[var(--text-secondary)]">Heuristic Classification</span>
                <span className="text-sm font-semibold text-[var(--success)]">
                  {((routing.heuristic_rate ?? 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-tertiary)]">
                <span className="text-sm text-[var(--text-secondary)]">Fallback Rate</span>
                <span className={cn(
                  "text-sm font-semibold",
                  (routing.fallback_rate ?? 0) > 0.1 ? "text-[var(--warning)]" : "text-[var(--success)]"
                )}>
                  {((routing.fallback_rate ?? 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-tertiary)]">
                <span className="text-sm text-[var(--text-secondary)]">Validation Failures</span>
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {routing.validation_failures ?? 0}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-tertiary)]">
                <span className="text-sm text-[var(--text-secondary)]">Tokens Saved</span>
                <span className="text-sm font-semibold text-[var(--success)]">
                  {(routing.tokens_saved ?? 0).toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cache Details */}
      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-5 mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Cache Performance</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">L1 exact-match · L2 semantic</p>
          </div>
          <Database className="w-4 h-4 text-[var(--text-muted)]" />
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : !cache ? (
          <EmptyState
            icon={Database}
            title="No cache data yet"
            description="L1/L2 cache hit rates appear here once Eden handles enough traffic to populate them."
            size="sm"
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* L1 Cache */}
            <div className="p-4 rounded-lg border border-[var(--border-default)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-[var(--success)]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">L1 — Exact Match (Redis)</h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-2xl font-bold text-[var(--text-primary)]">{cache.l1_hits}</p>
                  <p className="text-xs text-[var(--text-muted)]">Hits</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[var(--text-primary)]">{cache.l1_misses}</p>
                  <p className="text-xs text-[var(--text-muted)]">Misses</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[var(--accent)]">{((cache.l1_hit_rate ?? 0) * 100).toFixed(1)}%</p>
                  <p className="text-xs text-[var(--text-muted)]">Hit Rate</p>
                </div>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-3">TTL: {cache.l1_ttl_seconds}s</p>
            </div>

            {/* L2 Cache */}
            <div className="p-4 rounded-lg border border-[var(--border-default)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">L2 — Semantic (Qdrant)</h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-2xl font-bold text-[var(--text-primary)]">{cache.l2_hits}</p>
                  <p className="text-xs text-[var(--text-muted)]">Hits</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[var(--text-primary)]">{cache.l2_misses}</p>
                  <p className="text-xs text-[var(--text-muted)]">Misses</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[var(--accent)]">{((cache.l2_hit_rate ?? 0) * 100).toFixed(1)}%</p>
                  <p className="text-xs text-[var(--text-muted)]">Hit Rate</p>
                </div>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-3">Similarity threshold: {cache.l2_threshold}</p>
            </div>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">How Cost Optimization Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-3 rounded-lg bg-[var(--bg-tertiary)]">
            <Cpu className="w-4 h-4 text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Intelligent Routing</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Tasks are classified by complexity and routed to the cheapest capable model tier (T1→T4).
            </p>
          </div>
          <div className="p-3 rounded-lg bg-[var(--bg-tertiary)]">
            <Database className="w-4 h-4 text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Multi-Layer Caching</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              L1 exact-match (Redis) and L2 semantic (Qdrant) caches reduce redundant LLM calls.
            </p>
          </div>
          <div className="p-3 rounded-lg bg-[var(--bg-tertiary)]">
            <Zap className="w-4 h-4 text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Token Optimization</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Prompt compression and context window management minimize tokens per request.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

