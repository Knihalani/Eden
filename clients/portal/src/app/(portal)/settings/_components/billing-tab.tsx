"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Loader2, CreditCard, Users, Code, Briefcase, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BillingUsage } from "@/components/billing/billing-types";

// Ponytail: use the shared ``BillingUsage`` shape from billing-types
// instead of redefining it here. Previously ``PlanLimits`` was missing
// several fields that ``api.getPlans`` returns (jobs_limit/jobs_used)
// and the cost_used_usd fields — kept in sync to one source of truth
// so the build doesn't fail.

export function BillingTab() {
  const { currentOrg } = useOrg();
  // ``api.getPlans`` and ``BillingUsage`` have drifted (the backend
  // adds fields the UI type doesn't include). Partial<> bridges
  // the gap so the build doesn't fail while keeping the UI type
  // as the read-side contract.
  const [plan, setPlan] = useState<Partial<BillingUsage> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (currentOrg) {
      loadBillingData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id]);

  const loadBillingData = async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const planData = await api.getPlans(currentOrg.id);
      setPlan(planData as Partial<BillingUsage>);
    } catch (e: any) {
      console.error("Failed to load billing data", e);
      setError(e.message || "Failed to load billing data");
    } finally {
      setLoading(false);
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

  const costUsed = plan?.cost_used_usd ?? 0;
  const costSoft = plan?.cost_soft_limit_usd ?? 0;
  const costHard = plan?.cost_hard_limit_usd ?? 0;
  const costPct = costHard > 0 ? Math.min(100, (costUsed / costHard) * 100) : 0;
  const costStatus = plan?.cost_status ?? "ok";

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 bg-[var(--error-dim)] border border-[var(--error)] rounded-lg flex items-center gap-2 text-[var(--error)]">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* PRIMARY: Spending this month */}
      <div className="p-6 bg-[var(--bg-primary)] rounded-xl border border-[var(--border)]">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--accent-faint)] rounded-lg">
              <CreditCard className="w-5 h-5 text-[var(--accent)]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">
                Spending this month
              </h2>
              <p className="text-sm text-[var(--text-secondary)]">
                {plan?.display_name ?? "Free"} plan · resets monthly
              </p>
            </div>
          </div>
          <span
            className={cn(
              "px-3 py-1 rounded-full text-sm font-medium",
              costStatus === "hard_exceeded"
                ? "bg-[var(--error-dim)] text-[var(--error)]"
                : costStatus === "soft_exceeded"
                  ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                  : "bg-[var(--terminal-faint)] text-[var(--terminal)]"
            )}
          >
            {costStatus === "hard_exceeded"
              ? "Cap reached"
              : costStatus === "soft_exceeded"
                ? "Near cap"
                : "Active"}
          </span>
        </div>

        <div className="flex items-baseline gap-2 mb-3">
          <span
            className={cn(
              "text-4xl font-bold tabular-nums",
              costStatus === "hard_exceeded"
                ? "text-[var(--error)]"
                : costStatus === "soft_exceeded"
                  ? "text-[var(--warning)]"
                  : "text-[var(--text-primary)]"
            )}
          >
            ${costUsed.toFixed(2)}
          </span>
          <span className="text-sm text-[var(--text-secondary)] tabular-nums">
            / ${costHard.toFixed(2)}
          </span>
          {costSoft > 0 && costSoft < costHard && (
            <span className="text-xs text-[var(--text-muted)] ml-2">
              (warning at ${costSoft.toFixed(2)})
            </span>
          )}
        </div>

        <div className="h-3 bg-[var(--bg-muted)] rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              costStatus === "hard_exceeded"
                ? "bg-[var(--error)]"
                : costStatus === "soft_exceeded"
                  ? "bg-[var(--warning)]"
                  : "bg-[var(--accent)]"
            )}
            style={{ width: `${costPct}%` }}
          />
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-2 tabular-nums">
          {costPct.toFixed(1)}% of monthly cap used
        </p>

        {costStatus === "hard_exceeded" && (
          <div className="mt-4 p-3 rounded-lg bg-[var(--error-dim)] border border-[var(--error)]/30 text-sm text-[var(--error)]">
            You&apos;ve hit your monthly free-tier spending cap. New spend-bearing
            requests will be blocked until next month, or until support raises
            your cap.
          </div>
        )}
      </div>

      {/* Resource breakdown (informational) */}
      <div className="p-6 bg-[var(--bg-primary)] rounded-xl border border-[var(--border)]">
        <h3 className="text-lg font-semibold mb-1">Resource breakdown</h3>
        <p className="text-sm text-[var(--text-secondary)] mb-4">
          Where the spend came from this month — informational; your cap is on
          total USD cost.
        </p>
        <div className="space-y-4">
          <UsageMeter
            label="Seats"
            used={plan?.seats_used || 0}
            limit={plan?.seats_limit || 0}
            icon={Users}
          />
          <UsageMeter
            label="Code References"
            used={plan?.references_used || 0}
            limit={plan?.references_limit || 0}
            icon={Code}
          />
          <UsageMeter
            label="LLM tokens"
            used={plan?.tokens_used || 0}
            limit={0}
            icon={Briefcase}
            unit="tokens"
          />
        </div>
      </div>

      {/* Free plan notice */}
      {!plan?.stripe_subscription_id && (
        <div className="p-6 bg-[var(--bg-primary)] rounded-xl border border-[var(--border)]">
          <div className="flex items-start gap-3">
            <CreditCard className="w-5 h-5 text-[var(--terminal)] flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-lg font-semibold">You&apos;re on the Free plan</h3>
              <p className="text-sm text-[var(--text-secondary)] mt-1">
                Eden is currently free for everyone. Your cap is on the total
                USD cost Eden incurs running your workloads this month — so
                heavy traffic slows rather than surprise-bills you. Paid plans
                aren&apos;t available yet; if you need more headroom, reach out
                and we&apos;ll raise your cap manually.
              </p>
            </div>
          </div>
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
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  icon: any;
  unit?: string;
}) {
  const displayLimit =
    limit > 0 ? `${limit.toLocaleString()}${unit ? " " + unit : ""}` : "—";
  const percentage = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isNearLimit = limit > 0 && percentage >= 80;
  const isAtLimit = limit > 0 && percentage >= 100;

  return (
    <div className="flex items-center gap-4">
      <Icon
        className={cn(
          "w-5 h-5",
          isAtLimit
            ? "text-[var(--error)]"
            : isNearLimit
              ? "text-[var(--warning)]"
            : "text-[var(--text-muted)]"
        )}
      />
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-sm text-[var(--text-secondary)] tabular-nums">
            {used.toLocaleString()}
            {unit ? " " + unit : ""} {limit > 0 ? `/ ${displayLimit}` : ""}
          </span>
        </div>
        {limit > 0 ? (
          <div className="h-2 bg-[var(--bg-muted)] rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                isAtLimit
                  ? "bg-[var(--error)]"
                  : isNearLimit
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--accent)]"
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>
        ) : (
          <div className="h-2 bg-[var(--bg-muted)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--accent)]/30"
              style={{ width: "100%" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}