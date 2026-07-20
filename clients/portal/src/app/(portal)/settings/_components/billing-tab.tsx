"use client";

import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { RefreshCw, CreditCard, Users, Code, Briefcase, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BillingUsage } from "@/components/billing/billing-types";

// Ponytail: use the shared ``BillingUsage`` shape from billing-types
// instead of redefining it here. Previously ``PlanLimits`` was missing
// several fields that ``api.getPlans`` returns (jobs_limit/jobs_used)
// and the cost_used_usd fields — kept in sync to one source of truth
// so the build doesn't fail.
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import {
  featureGatedErrorCopy,
  isPaidPlansDisabledError,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";

export function BillingTab() {
  const {
    currentOrg
  } = useOrg();
  const orgId = currentOrg?.id ?? null;
  // ``api.getPlans`` and ``BillingUsage`` have drifted (the backend
  // adds fields the UI type doesn't include). Partial<> bridges
  // the gap so the build doesn't fail while keeping the UI type
  // as the read-side contract.
  const planQuery = useOrgQuery(
    queryKeys.settings.billing(orgId),
    orgId,
    () => api.getPlans(orgId!) as Promise<Partial<BillingUsage>>,
  );
  const plan = planQuery.data ?? null;
  const loading = planQuery.isLoading;
  const planError = planQuery.error ?? null;
  if (!currentOrg) {
    return <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage billing
      </div>;
  }
  if (loading) {
    return (
      <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
        <div className="h-40 rounded-xl bg-[var(--bg-muted)] animate-pulse" />
        <div className="h-32 rounded-xl bg-[var(--bg-muted)] animate-pulse" />
      </div>
    );
  }
  const errorCopy = planError
    ? featureGatedErrorCopy(planError, "Could not load billing")
    : null;
  const freeOnlyError = planError ? isPaidPlansDisabledError(planError) : false;
  // Match billing-overview: never paint false $0 Free KPIs on load failure.
  const showUsage = plan != null && !planError;
  const costUsed = plan?.cost_used_usd ?? 0;
  const costSoft = plan?.cost_soft_limit_usd ?? 0;
  const costHard = plan?.cost_hard_limit_usd ?? 0;
  const costPct = costHard > 0 ? Math.min(100, (costUsed / costHard) * 100) : 0;
  const costStatus = plan?.cost_status ?? "ok";

  return <div className="space-y-6">
      {/* Stripe probe: free-only 503 is treated as available so this
          banner stays hidden; true Stripe misconfig still surfaces. */}
      <IntegrationStatusBanners integration="stripe" orgId={currentOrg.id} />

      {errorCopy && freeOnlyError && (
        <div
          className="p-4 rounded-lg flex items-start gap-2 text-sm bg-[var(--bg-muted)] border border-[var(--border-default)] text-[var(--text-secondary)]"
          role="status"
        >
          <Info className="w-5 h-5 flex-shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[var(--text-primary)]">{errorCopy.title}</p>
            <p className="mt-0.5">{errorCopy.message}</p>
          </div>
        </div>
      )}

      {errorCopy && !freeOnlyError && (
        <ErrorState
          title={errorCopy.title}
          message={errorCopy.message}
          action={
            isRetryableIntelligenceError(planError) ? (
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => void planQuery.refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
            ) : undefined
          }
        />
      )}

      {showUsage && (
      <>
      {/* PRIMARY: Spending this month */}
      <Card padding="xl">
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
          <span className={cn("px-3 py-1 rounded-full text-sm font-medium", costStatus === "hard_exceeded" ? "bg-[var(--error-dim)] text-[var(--error)]" : costStatus === "soft_exceeded" ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--terminal-faint)] text-[var(--terminal)]")}>
            {costStatus === "hard_exceeded" ? "Cap reached" : costStatus === "soft_exceeded" ? "Near cap" : "Active"}
          </span>
        </div>

        <div className="flex items-baseline gap-2 mb-3">
          <span className={cn("text-4xl font-bold tabular-nums", costStatus === "hard_exceeded" ? "text-[var(--error)]" : costStatus === "soft_exceeded" ? "text-[var(--warning)]" : "text-[var(--text-primary)]")}>
            ${costUsed.toFixed(2)}
          </span>
          <span className="text-sm text-[var(--text-secondary)] tabular-nums">
            / ${costHard.toFixed(2)}
          </span>
          {costSoft > 0 && costSoft < costHard && <span className="text-xs text-[var(--text-muted)] ml-2">
              (warning at ${costSoft.toFixed(2)})
            </span>}
        </div>

        <div className="h-3 bg-[var(--bg-muted)] rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", costStatus === "hard_exceeded" ? "bg-[var(--error)]" : costStatus === "soft_exceeded" ? "bg-[var(--warning)]" : "bg-[var(--accent)]")} style={{
          width: `${costPct}%`
        }} />
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-2 tabular-nums">
          {costPct.toFixed(1)}% of monthly cap used
        </p>

        {costStatus === "hard_exceeded" && <div className="mt-4 p-3 rounded-lg bg-[var(--error-dim)] border border-[var(--error)]/30 text-sm text-[var(--error)]">
            You&apos;ve hit your monthly free-tier spending cap. New spend-bearing
            requests will be blocked until next month, or until support raises
            your cap.
          </div>}
      </Card>

      {/* Resource breakdown (informational) */}
      <Card padding="xl">
        <h3 className="text-lg font-semibold mb-1">Resource breakdown</h3>
        <p className="text-sm text-[var(--text-secondary)] mb-4">
          Where the spend came from this month — informational; your cap is on
          total USD cost.
        </p>
        <div className="space-y-4">
          <UsageMeter label="Seats" used={plan?.seats_used || 0} limit={plan?.seats_limit || 0} icon={Users} />
          <UsageMeter label="Code References" used={plan?.references_used || 0} limit={plan?.references_limit || 0} icon={Code} />
          <UsageMeter label="LLM tokens" used={plan?.tokens_used || 0} limit={0} icon={Briefcase} unit="tokens" />
        </div>
      </Card>

      {/* Free plan notice */}
      {!plan?.stripe_subscription_id && <Card padding="xl">
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
        </Card>}
      </>
      )}
    </div>;
}
function UsageMeter({
  label,
  used,
  limit,
  icon: Icon,
  unit
}: {
  label: string;
  used: number;
  limit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any;
  unit?: string;
}) {
  const displayLimit = limit > 0 ? `${limit.toLocaleString()}${unit ? " " + unit : ""}` : "—";
  const percentage = limit > 0 ? Math.min(used / limit * 100, 100) : 0;
  const isNearLimit = limit > 0 && percentage >= 80;
  const isAtLimit = limit > 0 && percentage >= 100;
  return <div className="flex items-center gap-4">
      <Icon className={cn("w-5 h-5", isAtLimit ? "text-[var(--error)]" : isNearLimit ? "text-[var(--warning)]" : "text-[var(--text-muted)]")} />
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-sm text-[var(--text-secondary)] tabular-nums">
            {used.toLocaleString()}
            {unit ? " " + unit : ""} {limit > 0 ? `/ ${displayLimit}` : ""}
          </span>
        </div>
        {limit > 0 ? <div className="h-2 bg-[var(--bg-muted)] rounded-full overflow-hidden">
            <div className={cn("h-full rounded-full transition-all", isAtLimit ? "bg-[var(--error)]" : isNearLimit ? "bg-[var(--warning)]" : "bg-[var(--accent)]")} style={{
            width: `${percentage}%`
          }} />
          </div> : <div className="h-2 bg-[var(--bg-muted)] rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-[var(--accent)]/30" style={{
            width: "100%"
          }} />
          </div>}
      </div>
    </div>;
}
