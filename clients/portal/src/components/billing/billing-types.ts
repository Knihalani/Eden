export const BILLING_PLANS = [
  {
    name: "Starter",
    slug: "starter",
    price: "$29",
    period: "/month",
    description: "For individuals and small projects",
    features: ["5 jobs/month", "Up to 10 environments", "Community support", "Basic analytics"],
  },
  {
    name: "Pro",
    slug: "pro",
    price: "$99",
    period: "/month",
    description: "For professional developers and teams",
    features: ["50 jobs/month", "Up to 100 environments", "Priority support", "Advanced analytics", "API access"],
    popular: true,
  },
  {
    name: "Enterprise",
    slug: "enterprise",
    price: "Custom",
    period: "",
    description: "For organizations with advanced needs",
    features: [
      "Unlimited jobs",
      "Unlimited environments",
      "Dedicated support",
      "SSO/SAML",
      "Audit logging",
      "Custom integrations",
    ],
  },
] as const;

export interface BillingUsage {
  plan_name: string;
  seats_limit: number;
  seats_used: number;
  references_limit: number;
  references_used: number;
  jobs_limit: number;
  jobs_used: number;
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
