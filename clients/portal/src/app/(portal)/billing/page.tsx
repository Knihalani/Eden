"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  CreditCard,
  Check,
  AlertTriangle,
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Receipt,
  Sparkles,
  Building2,
  Zap,
  Crown,
  ArrowUpRight,
  Calendar,
  CircleDollarSign,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

interface PlanSpec {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  popular?: boolean;
  icon: typeof Sparkles;
  accent: "accent" | "terminal" | "warning";
}

const PLANS: PlanSpec[] = [
  {
    name: "Starter",
    price: "$29",
    period: "/month",
    description: "For individuals and small projects",
    features: ["5 jobs/month", "Up to 10 environments", "Community support", "Basic analytics"],
    icon: Zap,
    accent: "accent",
  },
  {
    name: "Pro",
    price: "$99",
    period: "/month",
    description: "For professional developers and teams",
    features: ["50 jobs/month", "Up to 100 environments", "Priority support", "Advanced analytics", "API access"],
    popular: true,
    icon: Sparkles,
    accent: "accent",
  },
  {
    name: "Enterprise",
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
    icon: Crown,
    accent: "warning",
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

const INVOICES_PER_PAGE = 5;

export default function BillingPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicePage, setInvoicePage] = useState(0);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<{
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
  } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (currentOrg) loadData();
  }, [currentOrg]);

  const loadData = async () => {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const [usageData, invoiceData, paymentData] = await Promise.all([
        api.getPlans(currentOrg.id).catch(() => null),
        api.getInvoices(currentOrg.id).catch(() => []),
        api.getPaymentMethod(currentOrg.id).catch(() => null),
      ]);
      setUsage(usageData);
      setInvoices(invoiceData);
      setPaymentMethod(paymentData);
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to upgrade";
      toast.error(message);
    } finally {
      setUpgrading(null);
    }
  };

  const currentPlanIndex = PLANS.findIndex(
    (p) => p.name.toLowerCase() === usage?.plan_name?.toLowerCase(),
  );
  const paginatedInvoices = invoices.slice(
    invoicePage * INVOICES_PER_PAGE,
    (invoicePage + 1) * INVOICES_PER_PAGE,
  );
  const totalInvoicePages = Math.max(1, Math.ceil(invoices.length / INVOICES_PER_PAGE));

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading billing…
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 page-enter">
      <PageHeader
        title="Billing"
        subtitle={
          <>
            Manage your subscription and billing for{" "}
            <span className="text-[var(--text-secondary)] font-medium">
              {currentOrg?.name || "your organization"}
            </span>
          </>
        }
        icon={CircleDollarSign}
      />

      {/* Current plan + usage */}
      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Building2 className="w-4 h-4 text-[var(--text-muted)]" />
              Current plan
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Your current subscription tier
            </p>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-full",
              usage?.active
                ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
            )}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                usage?.active ? "bg-[var(--terminal)]" : "bg-[var(--text-muted)]",
              )}
            />
            {usage?.plan_name || "Free"} plan
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <UsageMeter
            label="Jobs"
            used={usage?.jobs_used ?? 0}
            limit={usage?.jobs_limit ?? 0}
            color="accent"
          />
          <UsageMeter
            label="Seats"
            used={usage?.seats_used ?? 0}
            limit={usage?.seats_limit ?? 0}
            color="terminal"
          />
          <UsageMeter
            label="References"
            used={usage?.references_used ?? 0}
            limit={usage?.references_limit ?? 0}
            color="warning"
          />
        </div>

        {usage?.current_period_end && (
          <p className="text-xs text-[var(--text-muted)] mt-4 flex items-center gap-1.5">
            <Calendar className="w-3 h-3" />
            Next billing date:{" "}
            {new Date(usage.current_period_end).toLocaleDateString()}
          </p>
        )}
      </Card>

      {/* Usage alert */}
      {usage && usage.jobs_limit > 0 && usage.jobs_used / usage.jobs_limit > 0.8 && (
        <div className="p-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] flex items-start gap-2.5 text-sm text-[var(--warning)]">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">
              You&apos;ve used {Math.round((usage.jobs_used / usage.jobs_limit) * 100)}% of
              your monthly jobs.
            </p>
            <p className="text-xs opacity-80 mt-0.5">
              Consider upgrading if you expect to exceed your limit.
            </p>
          </div>
        </div>
      )}

      {/* Available plans */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--accent)]" />
          Available plans
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PLANS.map((plan) => {
            const isCurrentPlan =
              plan.name.toLowerCase() === usage?.plan_name?.toLowerCase();
            const isUpgrade = currentPlanIndex < PLANS.findIndex((p) => p.name === plan.name);
            const Icon = plan.icon;
            return (
              <Card
                key={plan.name}
                className={cn(
                  "p-5 relative transition-all",
                  plan.popular &&
                    "ring-1 ring-[var(--accent)]/40 border-[var(--accent)]/50",
                  isCurrentPlan && "border-[var(--terminal)]/40 ring-1 ring-[var(--terminal)]/30",
                )}
              >
                {plan.popular && !isCurrentPlan && (
                  <span className="absolute -top-2.5 left-4 px-2 py-0.5 bg-[var(--accent)] text-[var(--bg-base)] text-[10px] font-bold uppercase tracking-wider rounded-full">
                    Most popular
                  </span>
                )}
                {isCurrentPlan && (
                  <span className="absolute -top-2.5 left-4 px-2 py-0.5 bg-[var(--terminal)] text-[var(--bg-base)] text-[10px] font-bold uppercase tracking-wider rounded-full">
                    Current
                  </span>
                )}

                <div className="flex items-center gap-2 mb-3">
                  <div
                    className={cn(
                      "p-1.5 rounded-md",
                      plan.accent === "accent"
                        ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                        : plan.accent === "terminal"
                          ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                          : "bg-[var(--warning-bg)] text-[var(--warning)]",
                    )}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">
                    {plan.name}
                  </h3>
                </div>

                <div className="flex items-baseline gap-1 mb-2">
                  <span className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
                    {plan.price}
                  </span>
                  {plan.period && (
                    <span className="text-xs text-[var(--text-muted)]">{plan.period}</span>
                  )}
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4 min-h-[2.5em]">
                  {plan.description}
                </p>

                <ul className="space-y-1.5 mb-5">
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]"
                    >
                      <Check className="w-3 h-3 text-[var(--terminal)] flex-shrink-0 mt-0.5" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {plan.price === "Custom" ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => (window.location.href = "mailto:sales@eden.dev")}
                  >
                    Contact sales
                    <ArrowUpRight className="w-3 h-3 ml-1" />
                  </Button>
                ) : isCurrentPlan ? (
                  <Button variant="outline" className="w-full" disabled>
                    Current plan
                  </Button>
                ) : isUpgrade ? (
                  <Button
                    variant="default"
                    className="w-full"
                    onClick={() => handleUpgrade(plan.name)}
                    disabled={upgrading === plan.name}
                  >
                    {upgrading === plan.name ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      "Upgrade"
                    )}
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" disabled>
                    Downgrade
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* Payment method */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            <CreditCard className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Payment method</h2>
            <p className="text-xs text-[var(--text-muted)]">Manage your payment information</p>
          </div>
        </div>

        <div className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-lg">
          {paymentMethod ? (
            <div className="flex items-center gap-3">
              <div className="w-12 h-7 bg-gradient-to-r from-blue-600 to-blue-800 rounded flex items-center justify-center">
                <span className="text-white text-[10px] font-bold uppercase">
                  {paymentMethod.brand}
                </span>
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)] font-mono">
                  •••• {paymentMethod.last4}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Expires {String(paymentMethod.exp_month).padStart(2, "0")}/
                  {paymentMethod.exp_year}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-[var(--text-muted)]">
              <CreditCard className="w-5 h-5" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  No payment method on file
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Add a card to enable paid plans
                </p>
              </div>
            </div>
          )}
          <Button variant="ghost" size="sm">
            {paymentMethod ? "Update" : "Add payment method"}
          </Button>
        </div>
      </Card>

      {/* Invoice history */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            <Receipt className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Invoice history</h2>
            <p className="text-xs text-[var(--text-muted)]">
              {invoices.length === 0
                ? "No invoices yet"
                : `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {invoices.length === 0 ? (
          <div className="text-center py-10">
            <FileText className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-50" />
            <p className="text-sm text-[var(--text-muted)]">
              Invoices will appear here once you subscribe to a paid plan.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {paginatedInvoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="flex items-center justify-between p-3 border border-[var(--border-default)] rounded-lg hover:border-[var(--border-strong)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)] flex-shrink-0">
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {new Date(invoice.created * 1000).toLocaleDateString("en-US", {
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {usage?.plan_name || "Plan"} plan
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-medium text-[var(--text-primary)] tabular-nums">
                      {invoice.currency === "usd" ? "$" : invoice.currency}
                      {(invoice.amount_paid / 100).toFixed(2)}
                    </span>
                    <span
                      className={cn(
                        "px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded",
                        invoice.status === "paid"
                          ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                          : invoice.status === "pending"
                            ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                            : "bg-[var(--error-dim)] text-[var(--error)]",
                      )}
                    >
                      {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                    </span>
                    {invoice.invoice_url && (
                      <a
                        href={invoice.invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {totalInvoicePages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--border-default)]">
                <p className="text-xs text-[var(--text-muted)]">
                  Page {invoicePage + 1} of {totalInvoicePages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInvoicePage((p) => Math.max(0, p - 1))}
                    disabled={invoicePage === 0}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInvoicePage((p) => Math.min(totalInvoicePages - 1, p + 1))}
                    disabled={invoicePage >= totalInvoicePages - 1}
                  >
                    Next
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
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
  color: "accent" | "terminal" | "warning";
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isHigh = limit > 0 && used / limit > 0.8;
  const fillClass =
    color === "accent"
      ? "bg-[var(--accent)]"
      : color === "terminal"
        ? "bg-[var(--terminal)]"
        : "bg-[var(--warning)]";
  return (
    <div className="p-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]/40">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-medium">
          {label}
        </p>
        <span
          className={cn(
            "text-sm font-semibold tabular-nums",
            isHigh ? "text-[var(--warning)]" : "text-[var(--text-primary)]",
          )}
        >
          {used} / {limit || "∞"}
        </span>
      </div>
      <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
        <div
          className={cn("h-full transition-all duration-500", fillClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
