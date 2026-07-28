/**
 * Thin budget read API — catalog sync / cost page without ``resources.ts``.
 */
import { fetchApi } from "@/lib/api/core";

export type BudgetPayload = {
  data: {
    budget: {
      window: string;
      cost_soft_limit_usd: number;
      cost_hard_limit_usd: number;
      enforcement_enabled: boolean;
      action_on_exceed: string;
      threshold_alert_pct: number;
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
};
