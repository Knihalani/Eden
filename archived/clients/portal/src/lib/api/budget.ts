/**
 * Thin budget read API — catalog sync / cost page without ``resources.ts``.
 */
import { fetchApi } from "@/lib/api/core";

/** W3-1 (1.4): sampling rollout observability counters returned by /billing/sampling-stats. */
export type SamplingStatsPayload = {
  profile: "full" | "balanced" | "aggressive";
  /** Traces dropped by the sampling gate in the last 24 h. */
  sampled_out_24h: number;
  /** Aggregate cost (USD) of sampled-out traces in the last 24 h. */
  sampled_out_cost_usd_24h: number;
  /** Configured keep rate for non-signal traces, expressed as a percentage (0–100). */
  keep_rate_pct: number;
};

/** W3-4: plan limits + current-period usage from ``GET /billing/plans``. */
export type PlanLimitsPayload = {
  plan_name: string;
  display_name?: string;
  /** Primary free-tier meter — 100 credits = $1 Eden COGS. */
  credits_used?: number;
  credits_soft_limit?: number;
  credits_hard_limit?: number;
  credits_status?: string;
  cost_used_usd?: number;
  cost_soft_limit_usd?: number;
  cost_hard_limit_usd?: number;
  cost_status?: string;
  seats_limit: number;
  seats_used: number;
  references_limit: number;
  references_used: number;
  tokens_used?: number;
  storage_mb_used?: number;
  sandbox_seconds_used?: number;
  active: boolean;
  stripe_subscription_id?: string;
  subscription_status?: string;
  current_period_end?: string;
};

export type BudgetPayload = {
  data: {
    budget: {
      window: string;
      cost_soft_limit_usd: number;
      cost_hard_limit_usd: number;
      enforcement_enabled: boolean;
      action_on_exceed: string;
      threshold_alert_pct: number;
      alert_thresholds?: number[];
      source: string;
    };
    consumption: {
      window: string;
      cost_usd: number;
      requests_count: number;
      window_start?: string;
    };
    rollup: {
      cost_used_usd: number;
      cost_soft_limit_usd: number;
      cost_hard_limit_usd: number;
      pct_of_hard: number;
      threshold_alert_pct: number;
      alert_breached: boolean;
      exceeded: boolean;
    };
  };
};

export const budgetApi = {
  get: (orgId: string) => fetchApi<BudgetPayload>(`/orgs/${orgId}/budget`),
  /** W3-1 (1.4): tail-sampling rollout observability — kept/sampled counters. */
  samplingStats: (orgId: string) =>
    fetchApi<SamplingStatsPayload>(`/orgs/${orgId}/billing/sampling-stats`),
  /** W3-4: current plan limits + period usage for the usage-meter UI. */
  planLimits: (orgId: string) =>
    fetchApi<PlanLimitsPayload>(`/orgs/${orgId}/billing/plans`),
};
