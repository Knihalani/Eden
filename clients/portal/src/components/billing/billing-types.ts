// Ponytail: paid plans are off (June 2026 — early stage, free-only).
// The BILLING_PLANS array previously drove the "Available plans" +
// upgrade CTAs. Empty it now so any leftover consumer renders an empty
// list rather than fetching prices that don't exist. When paid plans
// ship, repopulate from the backend ``/billing/plans`` endpoint
// (single source of truth = ``eden.services.plan_tiers.PLAN_TIERS``).
export const BILLING_PLANS: readonly never[] = [];

export interface BillingUsage {
  plan_name: string;
  display_name: string;
  // PRIMARY free-tier cap — USD cost this period.
  cost_used_usd: number;
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
  cost_status: "ok" | "soft_exceeded" | "hard_exceeded";
  // Resource counts (informational — the cost cap is the enforcement lever).
  seats_limit: number;
  seats_used: number;
  references_limit: number;
  references_used: number;
  tokens_used: number;
  storage_mb_used: number;
  sandbox_seconds_used: number;
  active: boolean;
  stripe_subscription_id?: string;
  subscription_status?: string;
  current_period_end?: string;
}

export interface BillingInvoice {
  id: string;
  amount_paid: number;
  currency: string;
  status: string;
  created: number;
  invoice_url?: string;
}

export interface PaymentMethodInfo {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}