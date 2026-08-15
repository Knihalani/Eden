/**
 * Thin gateway read API — keeps ``gateway/page.tsx`` off ``resources.ts``.
 */
import { fetchApi } from "@/lib/api/core";

/** Matches ``resources.gatewayOverview`` — kept here so the page stays off the mega module. */
export type GatewayOverview = {
  status: string;
  data: {
    total_cost_usd: number;
    previous_cost_usd: number;
    delta_usd: number;
    delta_pct: number | null;
    by_feature: Array<{
      key?: string;
      cost_usd: number;
      events: number;
      tokens: number;
    }>;
    by_model: Array<{
      key?: string;
      cost_usd: number;
      events: number;
      tokens: number;
    }>;
    by_agent: Array<{
      key?: string;
      cost_usd: number;
      events: number;
      tokens: number;
    }>;
    by_day: Array<{
      day?: string;
      cost_usd: number;
      events: number;
      tokens: number;
      input_tokens?: number;
      output_tokens?: number;
    }>;
    untagged_events: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    events: number;
    cache_savings_usd: number;
    window_hours: number;
    models?: Array<{
      model_id: string;
      name: string;
      provider: string;
      upstream_model: string;
      enabled: boolean;
      routing_priority: number;
    }>;
    cache?: {
      hits?: number;
      misses?: number;
      hit_rate?: number;
      l1_hits?: number;
      l1_misses?: number;
      l2_hits?: number;
      l2_misses?: number;
      l1_hit_rate?: number;
      l2_hit_rate?: number;
    } | null;
    providers?: Array<{
      provider: string;
      healthy: boolean;
      avg_latency_ms?: number;
      error_rate?: number;
    }>;
  };
};

export const gatewayApi = {
  overview: (orgId: string, windowHours = 24) =>
    fetchApi<GatewayOverview>(
      `/orgs/${orgId}/gateway/overview?window_hours=${windowHours}`,
    ),
};
