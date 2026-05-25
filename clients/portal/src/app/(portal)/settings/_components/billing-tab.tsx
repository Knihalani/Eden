"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Loader2, CreditCard, Users, Code, Briefcase, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanLimits {
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

interface Invoice {
  id: string;
  amount_paid: number;
  currency: string;
  status: string;
  created: number;
  invoice_url?: string;
}

export function BillingTab() {
  const { currentOrg } = useOrg();
  const [plan, setPlan] = useState<PlanLimits | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (currentOrg) {
      loadBillingData();
    }
  }, [currentOrg?.id]);

  const loadBillingData = async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const [planData, invoicesData] = await Promise.all([
        api.getPlans(currentOrg.id),
        api.getInvoices(currentOrg.id),
      ]);
      setPlan(planData);
      setInvoices(invoicesData);
    } catch (e: any) {
      console.error("Failed to load billing data", e);
      setError(e.message || "Failed to load billing data");
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async (planName: string) => {
    if (!currentOrg) return;
    setSubscribing(true);
    setError(null);
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
      setError(e.message || "Failed to create checkout session");
      setSubscribing(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!currentOrg || !confirm("Are you sure you want to cancel your subscription? You'll lose access to premium features at the end of your billing period.")) return;
    setCancelling(true);
    setError(null);
    try {
      await api.cancelSubscription(currentOrg.id);
      await loadBillingData();
    } catch (e: any) {
      setError(e.message || "Failed to cancel subscription");
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
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Current Plan */}
      <div className="p-6 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <CreditCard className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold capitalize">{plan?.plan_name || "Free"} Plan</h2>
              {plan?.subscription_status && (
                <p className="text-sm text-[var(--text-secondary)]">
                  Status: {plan.subscription_status}
                  {plan.current_period_end && ` · renews ${formatDate(Math.floor(new Date(plan.current_period_end).getTime() / 1000))}`}
                </p>
              )}
            </div>
          </div>
          {!plan?.stripe_subscription_id && (
            <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
              Active
            </span>
          )}
        </div>

        {/* Usage Meters */}
        <div className="space-y-4">
          <UsageMeter
            label="Seats"
            used={plan?.seats_used || 0}
            limit={plan?.seats_limit || 2}
            icon={Users}
          />
          <UsageMeter
            label="Code References"
            used={plan?.references_used || 0}
            limit={plan?.references_limit || 10}
            icon={Code}
          />
          <UsageMeter
            label="Jobs"
            used={plan?.jobs_used || 0}
            limit={plan?.jobs_limit || 20}
            icon={Briefcase}
          />
        </div>
      </div>

      {/* Upgrade Options */}
      {!plan?.stripe_subscription_id && (
        <div className="p-6 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
          <h3 className="text-lg font-semibold mb-4">Upgrade Your Plan</h3>
          <div className="grid grid-cols-3 gap-4">
            {["starter", "pro", "enterprise"].map((planName) => (
              <div
                key={planName}
                className="p-4 border border-[var(--border)] rounded-lg hover:border-blue-500 transition-colors"
              >
                <h4 className="font-semibold capitalize mb-2">{planName}</h4>
                <p className="text-2xl font-bold mb-1">
                  ${planName === "starter" ? 29 : planName === "pro" ? 79 : 199}
                  <span className="text-sm font-normal text-[var(--text-secondary)]">/mo</span>
                </p>
                <ul className="text-sm text-[var(--text-secondary)] space-y-1 mb-4">
                  <li>{planName === "starter" ? "5" : planName === "pro" ? "15" : "50"} seats</li>
                  <li>{planName === "starter" ? "50" : planName === "pro" ? "200" : "1000"} references</li>
                  <li>{planName === "starter" ? "100" : planName === "pro" ? "500" : "2000"} jobs</li>
                </ul>
                <button
                  onClick={() => handleSubscribe(planName)}
                  disabled={subscribing}
                  className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {subscribing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {subscribing ? "Redirecting..." : "Upgrade"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cancel Subscription */}
      {plan?.stripe_subscription_id && (
        <div className="p-6 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
          <h3 className="text-lg font-semibold mb-2">Subscription Management</h3>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Your subscription will{" "}
            {plan.current_period_end
              ? `automatically cancel on ${formatDate(Math.floor(new Date(plan.current_period_end).getTime() / 1000))}`
              : "remain active until cancelled"}
            .
          </p>
          <button
            onClick={handleCancelSubscription}
            disabled={cancelling}
            className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50 flex items-center gap-2"
          >
            {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Cancel Subscription
          </button>
        </div>
      )}

      {/* Invoice History */}
      {invoices.length > 0 && (
        <div className="p-6 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
          <h3 className="text-lg font-semibold mb-4">Billing History</h3>
          <div className="space-y-3">
            {invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between p-3 bg-[var(--bg-muted)] rounded-lg"
              >
                <div>
                  <p className="font-medium">{formatCurrency(invoice.amount_paid, invoice.currency)}</p>
                  <p className="text-sm text-[var(--text-secondary)]">{formatDate(invoice.created)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn(
                    "px-2 py-1 rounded text-xs font-medium",
                    invoice.status === "paid" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                  )}>
                    {invoice.status}
                  </span>
                  {invoice.invoice_url && (
                    <a
                      href={invoice.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline text-sm"
                    >
                      View Invoice
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State for no invoices */}
      {plan?.stripe_subscription_id && invoices.length === 0 && !loading && (
        <div className="p-6 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
          <h3 className="text-lg font-semibold mb-2">Billing History</h3>
          <p className="text-sm text-[var(--text-secondary)]">No invoices yet.</p>
        </div>
      )}
    </div>
  );
}

function UsageMeter({
  label,
  used,
  limit,
  icon: Icon,
}: {
  label: string;
  used: number;
  limit: number;
  icon: any;
}) {
  const percentage = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isNearLimit = percentage >= 80;
  const isAtLimit = percentage >= 100;

  return (
    <div className="flex items-center gap-4">
      <Icon className={cn(
        "w-5 h-5",
        isAtLimit ? "text-red-500" : isNearLimit ? "text-yellow-500" : "text-[var(--text-muted)]"
      )} />
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-sm text-[var(--text-secondary)]">
            {used} / {limit}
          </span>
        </div>
        <div className="h-2 bg-[var(--bg-muted)] rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              isAtLimit ? "bg-red-500" : isNearLimit ? "bg-yellow-500" : "bg-blue-500"
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    </div>
  );
}