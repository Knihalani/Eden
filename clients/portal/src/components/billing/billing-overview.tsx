"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Loader2, CreditCard, Check, AlertCircle, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BILLING_PLANS,
  type BillingUsage,
  type BillingInvoice,
  type PaymentMethodInfo,
} from "./billing-types";

const INVOICES_PER_PAGE = 5;

interface BillingOverviewProps {
  variant?: "page" | "embedded";
}

export function BillingOverview({ variant = "page" }: BillingOverviewProps) {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodInfo | null>(null);
  const [invoicePage, setInvoicePage] = useState(0);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const loadData = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setFetchError(null);
    try {
      const [usageData, invoiceData, pmData] = await Promise.all([
        api.getPlans(currentOrg.id).catch(() => null),
        api.getInvoices(currentOrg.id).catch(() => []),
        api.getPaymentMethod(currentOrg.id).catch(() => null),
      ]);
      setUsage(usageData);
      setInvoices(invoiceData);
      setPaymentMethod(pmData);
    } catch (err) {
      console.error("Failed to load billing data", err);
      setFetchError("Could not load billing data. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    if (currentOrg) {
      loadData();
    }
  }, [currentOrg, loadData]);

  const handleUpgrade = async (planName: string) => {
    if (!currentOrg || planName === "Custom") return;
    setUpgrading(planName);
    try {
      const result = await api.subscribe(currentOrg.id, {
        plan_name: planName.toLowerCase(),
        success_url: window.location.href,
        cancel_url: window.location.href,
      });
      window.location.href = result.checkout_url;
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to upgrade");
    } finally {
      setUpgrading(null);
    }
  };

  const handleCancelSubscription = async () => {
    if (!currentOrg) return;
    if (
      !(await confirm({
        title: "Cancel subscription",
        description:
          "Are you sure you want to cancel? You will keep access until the end of the current billing period.",
        confirmLabel: "Cancel subscription",
        variant: "destructive",
      }))
    ) {
      return;
    }
    setCancelling(true);
    try {
      await api.cancelSubscription(currentOrg.id);
      toast.success("Subscription will cancel at period end");
      await loadData();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel subscription");
    } finally {
      setCancelling(false);
    }
  };

  if (!currentOrg) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage billing
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading billing…</span>
      </div>
    );
  }

  const currentPlanIndex = BILLING_PLANS.findIndex(
    (p) => p.slug === usage?.plan_name?.toLowerCase() || p.name.toLowerCase() === usage?.plan_name?.toLowerCase()
  );
  const paginatedInvoices = invoices.slice(
    invoicePage * INVOICES_PER_PAGE,
    (invoicePage + 1) * INVOICES_PER_PAGE
  );
  const totalInvoicePages = Math.ceil(invoices.length / INVOICES_PER_PAGE);

  const periodEndLabel = usage?.current_period_end
    ? new Date(
        Number.isNaN(Number(usage.current_period_end))
          ? usage.current_period_end
          : Number(usage.current_period_end) * 1000
      ).toLocaleDateString()
    : null;

  return (
    <div className={cn(variant === "page" ? "space-y-8" : "space-y-6")}>
      {fetchError && (
        <div className="p-4 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] text-sm text-[var(--error)] flex items-center justify-between gap-3">
          <span>{fetchError}</span>
          <button type="button" onClick={() => loadData()} className="font-medium underline shrink-0">
            Retry
          </button>
        </div>
      )}

      {/* Current plan + usage */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Current plan</h2>
            <p className="text-sm text-[var(--text-muted)]">
              {usage?.subscription_status
                ? `Status: ${usage.subscription_status}${periodEndLabel ? ` · renews ${periodEndLabel}` : ""}`
                : "Your current subscription tier"}
            </p>
          </div>
          <span
            className={cn(
              "px-3 py-1 text-sm font-medium rounded-full capitalize",
              usage?.active ? "bg-[var(--success-bg)] text-[var(--success)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            )}
          >
            {usage?.plan_name || "Free"}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UsageMeter label="Jobs" used={usage?.jobs_used ?? 0} limit={usage?.jobs_limit ?? 0} color="accent" />
          <UsageMeter label="Seats" used={usage?.seats_used ?? 0} limit={usage?.seats_limit ?? 0} color="primary" />
          <UsageMeter
            label="References"
            used={usage?.references_used ?? 0}
            limit={usage?.references_limit ?? 0}
            color="warning"
          />
        </div>

        {periodEndLabel && (
          <p className="text-sm text-[var(--text-muted)] mt-4">Next billing date: {periodEndLabel}</p>
        )}
      </div>

      {usage && usage.jobs_limit > 0 && usage.jobs_used / usage.jobs_limit > 0.8 && (
        <div className="bg-[var(--warning-bg)] border border-[var(--warning)]/30 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-[var(--warning)] flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              You&apos;ve used {Math.round((usage.jobs_used / usage.jobs_limit) * 100)}% of your monthly jobs
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Consider upgrading if you expect to exceed your limit.
            </p>
          </div>
        </div>
      )}

      {/* Cancel subscription (embedded settings view) */}
      {usage?.stripe_subscription_id && (
        <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
          <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Subscription management</h3>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Your subscription will remain active until the end of the current billing period.
          </p>
          <Button variant="outline" onClick={handleCancelSubscription} disabled={cancelling} className="text-[var(--error)] border-[var(--error)]/30 hover:bg-[var(--error-bg)]">
            {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : "Cancel subscription"}
          </Button>
        </div>
      )}

      {/* Plans */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Available plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {BILLING_PLANS.map((plan) => {
            const isCurrentPlan =
              plan.slug === usage?.plan_name?.toLowerCase() ||
              plan.name.toLowerCase() === usage?.plan_name?.toLowerCase();
            const planIndex = BILLING_PLANS.findIndex((p) => p.name === plan.name);
            const isUpgrade = currentPlanIndex >= 0 && planIndex > currentPlanIndex;

            return (
              <div
                key={plan.name}
                className={cn(
                  "relative bg-[var(--bg-primary)] rounded-xl border p-6",
                  "popular" in plan && plan.popular
                    ? "border-[var(--accent)] ring-2 ring-[var(--accent-faint)]"
                    : "border-[var(--border-default)]"
                )}
              >
                {"popular" in plan && plan.popular && !isCurrentPlan && (
                  <span className="absolute -top-3 left-4 px-2 py-0.5 bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium rounded-full">
                    Most popular
                  </span>
                )}
                {isCurrentPlan && (
                  <span className="absolute -top-3 left-4 px-2 py-0.5 bg-[var(--success)] text-[var(--bg-base)] text-xs font-medium rounded-full">
                    Current
                  </span>
                )}
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-3xl font-bold text-[var(--text-primary)]">{plan.price}</span>
                    {plan.period && <span className="text-sm text-[var(--text-muted)]">{plan.period}</span>}
                  </div>
                  <p className="text-sm text-[var(--text-muted)] mt-1">{plan.description}</p>
                </div>
                <ul className="space-y-2 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                      <Check className="w-4 h-4 text-[var(--accent)] flex-shrink-0 mt-0.5" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {plan.price === "Custom" ? (
                  <Button variant="outline" className="w-full" onClick={() => (window.location.href = "mailto:sales@eden.dev")}>
                    Contact sales
                  </Button>
                ) : isCurrentPlan ? (
                  <Button variant="outline" className="w-full" disabled>
                    Current plan
                  </Button>
                ) : isUpgrade ? (
                  <Button variant="default" className="w-full" onClick={() => handleUpgrade(plan.name)} disabled={upgrading === plan.name}>
                    {upgrading === plan.name ? <Loader2 className="w-4 h-4 animate-spin" /> : "Upgrade"}
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" disabled title="Contact support to downgrade">
                    Downgrade
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Payment method */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <div className="flex items-center gap-3 mb-4">
          <CreditCard className="w-5 h-5 text-[var(--text-muted)]" />
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Payment method</h2>
            <p className="text-sm text-[var(--text-muted)]">Manage your payment information</p>
          </div>
        </div>
        {paymentMethod ? (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 border border-[var(--border-default)] rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-6 bg-[var(--primary)] rounded flex items-center justify-center">
                <span className="text-[var(--bg-base)] text-xs font-bold uppercase">{paymentMethod.brand.slice(0, 4)}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">•••• •••• •••• {paymentMethod.last4}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Expires {paymentMethod.exp_month}/{paymentMethod.exp_year}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => handleUpgrade(usage?.plan_name === "free" ? "Starter" : usage?.plan_name || "Starter")}>
              Update via checkout
            </Button>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 border border-dashed border-[var(--border-default)] rounded-lg bg-[var(--bg-secondary)] text-center sm:text-left">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">No payment method on file</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">Add a card when you upgrade to a paid plan.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => handleUpgrade("Starter")}>
              Upgrade to add card
            </Button>
          </div>
        )}
      </div>

      {/* Invoices */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Invoice history</h2>
        {invoices.length === 0 ? (
          <div className="text-center py-10">
            <CreditCard className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-secondary)]">No invoices yet</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Invoices appear here after your first paid billing cycle.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {paginatedInvoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border border-[var(--border-default)] rounded-lg"
                >
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      {new Date(invoice.created * 1000).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                    <p className="text-xs text-[var(--text-muted)] capitalize">{usage?.plan_name || "Plan"}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {invoice.currency === "usd" ? "$" : invoice.currency.toUpperCase()}
                      {(invoice.amount_paid / 100).toFixed(2)}
                    </span>
                    <span
                      className={cn(
                        "px-2 py-0.5 text-xs font-medium rounded capitalize",
                        invoice.status === "paid"
                          ? "bg-[var(--success-bg)] text-[var(--success)]"
                          : invoice.status === "pending"
                            ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                            : "bg-[var(--error-bg)] text-[var(--error)]"
                      )}
                    >
                      {invoice.status}
                    </span>
                    {invoice.invoice_url && (
                      <a
                        href={invoice.invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />
                        Download
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {totalInvoicePages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--border-default)]">
                <p className="text-sm text-[var(--text-muted)]">
                  Page {invoicePage + 1} of {totalInvoicePages}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setInvoicePage((p) => Math.max(0, p - 1))} disabled={invoicePage === 0}>
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

      {ConfirmDialog}
    </div>
  );
}

function UsageMeter({
  label,
  used,
  limit,
  color,
}: {
  label: string;
  used: number;
  limit: number;
  color: "accent" | "primary" | "warning";
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const barColor = {
    accent: "bg-[var(--accent)]",
    primary: "bg-[var(--primary)]",
    warning: "bg-[var(--warning)]",
  }[color];

  return (
    <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">{label}</p>
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {used} / {limit || "∞"}
        </span>
      </div>
      <div className="h-2 bg-[var(--border-default)] rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-300", barColor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
