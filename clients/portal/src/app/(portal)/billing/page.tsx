"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, CreditCard, Check, AlertCircle, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const PLANS = [
  {
    name: "Starter",
    price: "$29",
    period: "/month",
    description: "For individuals and small projects",
    features: ["5 jobs/month", "Up to 10 environments", "Community support", "Basic analytics"],
  },
  {
    name: "Pro",
    price: "$99",
    period: "/month",
    description: "For professional developers and teams",
    features: ["50 jobs/month", "Up to 100 environments", "Priority support", "Advanced analytics", "API access"],
    popular: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For organizations with advanced needs",
    features: ["Unlimited jobs", "Unlimited environments", "Dedicated support", "SSO/SAML", "Audit logging", "Custom integrations"],
  },
];

interface UsageData {
  plan_name: string;
  seats_limit: number;
  seats_used: number;
  references_limit: number;
  references_used: number;
  jobs_limit: number;
  jobs_used: number;
  active: boolean;
  subscription_status?: string;
  current_period_end?: string;
}

interface Invoice {
  id: string;
  amount_paid: number;
  currency: string;
  status: string;
  created: number;
  invoice_url?: string;
}

export default function BillingPage() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicePage, setInvoicePage] = useState(0);
  const [upgrading, setUpgrading] = useState<string | null>(null);

  const INVOICES_PER_PAGE = 5;

  useEffect(() => {
    if (currentOrg) {
      loadData();
    }
  }, [currentOrg]);

  const loadData = async () => {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const [usageData, invoiceData] = await Promise.all([
        api.getPlans(currentOrg.id).catch(() => null),
        api.getInvoices(currentOrg.id).catch(() => []),
      ]);
      setUsage(usageData);
      setInvoices(invoiceData);
    } catch (e) {
      console.error("Failed to load billing data", e);
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = async (planName: string) => {
    if (!currentOrg || planName === "Custom") return;
    setUpgrading(planName);
    try {
      const result = await api.subscribe(currentOrg.id, {
        plan_name: planName,
        success_url: window.location.href,
        cancel_url: window.location.href,
      });
      if (result.checkout_url) {
        window.location.href = result.checkout_url;
      }
    } catch (e: any) {
      alert(e.message || "Failed to upgrade");
    } finally {
      setUpgrading(null);
    }
  };

  const currentPlanIndex = PLANS.findIndex((p) => p.name.toLowerCase() === usage?.plan_name?.toLowerCase());
  const paginatedInvoices = invoices.slice(invoicePage * INVOICES_PER_PAGE, (invoicePage + 1) * INVOICES_PER_PAGE);
  const totalInvoicePages = Math.ceil(invoices.length / INVOICES_PER_PAGE);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading billing...</span>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Billing</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Manage your subscription and billing for {currentOrg?.name || "your organization"}
        </p>
      </div>

      {/* Current Plan Card */}
      <div className="bg-[var(--surface)] rounded-lg border border-[var(--border)] p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Current Plan</h2>
            <p className="text-sm text-[var(--text-muted)]">Your current subscription tier</p>
          </div>
          <span className={cn(
            "px-3 py-1 text-sm font-medium rounded-full",
            usage?.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
          )}>
            {usage?.plan_name || "Free"} Plan
          </span>
        </div>

        {/* Usage Meters */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Jobs Usage */}
          <div className="p-4 bg-[var(--bg-muted)] rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Jobs Used</p>
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {usage?.jobs_used || 0} / {usage?.jobs_limit || "∞"}
              </span>
            </div>
            <div className="h-2 bg-[var(--border)] rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{
                  width: usage?.jobs_limit
                    ? `${Math.min(100, ((usage?.jobs_used || 0) / usage.jobs_limit) * 100)}%`
                    : "0%",
                }}
              />
            </div>
          </div>

          {/* Seats Usage */}
          <div className="p-4 bg-[var(--bg-muted)] rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Seats Used</p>
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {usage?.seats_used || 0} / {usage?.seats_limit || "∞"}
              </span>
            </div>
            <div className="h-2 bg-[var(--border)] rounded-full overflow-hidden">
              <div
                className="h-full bg-teal-500 rounded-full transition-all duration-300"
                style={{
                  width: usage?.seats_limit
                    ? `${Math.min(100, ((usage?.seats_used || 0) / usage.seats_limit) * 100)}%`
                    : "0%",
                }}
              />
            </div>
          </div>

          {/* Storage Usage */}
          <div className="p-4 bg-[var(--bg-muted)] rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Storage Used</p>
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {usage?.references_used || 0} / {usage?.references_limit || "∞"}
              </span>
            </div>
            <div className="h-2 bg-[var(--border)] rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                style={{
                  width: usage?.references_limit
                    ? `${Math.min(100, ((usage?.references_used || 0) / usage.references_limit) * 100)}%`
                    : "0%",
                }}
              />
            </div>
          </div>
        </div>

        {usage?.current_period_end && (
          <p className="text-sm text-[var(--text-muted)] mt-4">
            Next billing date: {new Date(usage.current_period_end * 1000).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Usage Alert */}
      {usage && usage.jobs_limit > 0 && usage.jobs_used / usage.jobs_limit > 0.8 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-8 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800">
              You&apos;ve used {Math.round((usage.jobs_used / usage.jobs_limit) * 100)}% of your monthly jobs
            </p>
            <p className="text-xs text-amber-700 mt-0.5">Consider upgrading if you expect to exceed your limit.</p>
          </div>
        </div>
      )}

      {/* Available Plans */}
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Available Plans</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {PLANS.map((plan) => {
          const isCurrentPlan = plan.name.toLowerCase() === usage?.plan_name?.toLowerCase();
          const isUpgrade = currentPlanIndex < PLANS.findIndex((p) => p.name === plan.name);

          return (
            <div
              key={plan.name}
              className={cn(
                "relative bg-[var(--surface)] rounded-lg border p-6",
                plan.popular ? "border-blue-500 ring-2 ring-blue-100" : "border-[var(--border)]"
              )}
            >
              {plan.popular && !isCurrentPlan && (
                <span className="absolute -top-3 left-4 px-2 py-0.5 bg-blue-500 text-white text-xs font-medium rounded-full">
                  Most Popular
                </span>
              )}
              {isCurrentPlan && (
                <span className="absolute -top-3 left-4 px-2 py-0.5 bg-green-500 text-white text-xs font-medium rounded-full">
                  Current
                </span>
              )}
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-[var(--text-primary)]">{plan.name}</h3>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-3xl font-bold text-[var(--text-primary)]">{plan.price}</span>
                  {plan.period && (
                    <span className="text-sm text-[var(--text-muted)]">{plan.period}</span>
                  )}
                </div>
                <p className="text-sm text-[var(--text-muted)] mt-1">{plan.description}</p>
              </div>
              <ul className="space-y-2 mb-6">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                    <Check className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                    {feature}
                  </li>
                ))}
              </ul>
              {plan.price === "Custom" ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => window.location.href = "mailto:sales@eden.dev"}
                >
                  Contact Sales
                </Button>
              ) : isCurrentPlan ? (
                <Button variant="outline" className="w-full" disabled>
                  Current Plan
                </Button>
              ) : isUpgrade ? (
                <Button
                  variant="default"
                  className="w-full"
                  onClick={() => handleUpgrade(plan.name)}
                  disabled={upgrading === plan.name}
                >
                  {upgrading === plan.name ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    "Upgrade"
                  )}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled
                >
                  Downgrade
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Payment Method */}
      <div className="bg-[var(--surface)] rounded-lg border border-[var(--border)] p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <CreditCard className="w-5 h-5 text-[var(--text-muted)]" />
            <div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Payment Method</h2>
              <p className="text-sm text-[var(--text-muted)]">Manage your payment information</p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between p-4 border border-[var(--border)] rounded-lg">
          <div className="flex items-center gap-3">
            <div className="w-10 h-6 bg-gradient-to-r from-blue-600 to-blue-800 rounded flex items-center justify-center">
              <span className="text-white text-xs font-bold">VISA</span>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">•••• •••• •••• 4242</p>
              <p className="text-xs text-[var(--text-muted)]">Expires 12/2027</p>
            </div>
          </div>
          <Button variant="ghost" size="sm">
            Update
          </Button>
        </div>
      </div>

      {/* Invoice History */}
      <div className="bg-[var(--surface)] rounded-lg border border-[var(--border)] p-6 mt-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Invoice History</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] text-center py-8">No invoices yet</p>
        ) : (
          <>
            <div className="space-y-3">
              {paginatedInvoices.map((invoice) => (
                <div key={invoice.id} className="flex items-center justify-between p-3 border border-[var(--border)] rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      {new Date(invoice.created * 1000).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">{usage?.plan_name || "Plan"}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {invoice.currency === "usd" ? "$" : invoice.currency}
                      {(invoice.amount_paid / 100).toFixed(2)}
                    </span>
                    <span className={cn(
                      "px-2 py-0.5 text-xs font-medium rounded",
                      invoice.status === "paid" ? "bg-green-100 text-green-700" :
                      invoice.status === "pending" ? "bg-yellow-100 text-yellow-700" :
                      "bg-red-100 text-red-700"
                    )}>
                      {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                    </span>
                    {invoice.invoice_url && (
                      <a
                        href={invoice.invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />
                        Download
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalInvoicePages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--border)]">
                <p className="text-sm text-[var(--text-muted)]">
                  Page {invoicePage + 1} of {totalInvoicePages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInvoicePage((p) => Math.max(0, p - 1))}
                    disabled={invoicePage === 0}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInvoicePage((p) => Math.min(totalInvoicePages - 1, p + 1))}
                    disabled={invoicePage >= totalInvoicePages - 1}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}