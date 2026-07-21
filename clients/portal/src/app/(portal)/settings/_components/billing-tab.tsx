"use client";

/**
 * Billing leaf (Wave 5) — calm plan card + limits; one primary CTA.
 */

import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { RefreshCw, CreditCard, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BillingUsage } from "@/components/billing/billing-types";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import { SUPPORT_EMAIL } from "@/lib/constants";
import {
  featureGatedErrorCopy,
  isPaidPlansDisabledError,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";
import { PlanLimitsDisplay } from "./plan-limits-display";

export const WS5_BILLING_COMPLETED = true as const;

type PlanUsage = Partial<BillingUsage> & {
  jobs_used?: number;
  jobs_limit?: number;
};

export function BillingTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const planQuery = useOrgQuery(
    queryKeys.settings.billing(orgId),
    orgId,
    () => api.getPlans(orgId!) as Promise<PlanUsage>,
  );
  const plan = planQuery.data ?? null;
  const loading = planQuery.isLoading;
  const planError = planQuery.error ?? null;

  if (!currentOrg) {
    return (
      <div data-ws5-billing>
        <EmptyState
          icon={CreditCard}
          title="Select a workspace"
          description="Select a workspace to manage billing and plan limits."
          size="md"
          variant="panel"
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div
        data-ws5-billing
        className="space-y-3 py-4"
        aria-busy="true"
        aria-live="polite"
      >
        <div className="h-40 animate-pulse rounded-xl bg-[var(--bg-muted)]" />
        <div className="h-32 animate-pulse rounded-xl bg-[var(--bg-muted)]" />
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
  const planName = plan?.display_name ?? "Free";
  const headroomSubject = encodeURIComponent(
    `Request more headroom — ${planName} plan`,
  );
  const primaryCtaLabel =
    costStatus === "hard_exceeded" ? "Contact support" : "Request more headroom";

  return (
    <div data-ws5-billing className="space-y-space-6">
      {/* Stripe probe: free-only 503 stays available; true misconfig still surfaces. */}
      <IntegrationStatusBanners integration="stripe" orgId={currentOrg.id} />

      {errorCopy && freeOnlyError && (
        <div
          className="flex items-start gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-secondary)]"
          role="status"
        >
          <Info className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
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
          <SettingsCard
            title={`${planName} plan`}
            description="Spending this month · resets on the period boundary · hard cap is total USD cost"
            actions={
              <Button
                asChild
                variant="default"
                className="min-h-11"
                data-ws5-billing-cta
              >
                <a href={`mailto:${SUPPORT_EMAIL}?subject=${headroomSubject}`}>
                  {primaryCtaLabel}
                </a>
              </Button>
            }
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-[var(--text-primary)]">
                  Spending this month
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  Cap on total USD cost Eden incurs for this workspace
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium",
                  costStatus === "hard_exceeded"
                    ? "bg-[var(--error-dim)] text-[var(--error)]"
                    : costStatus === "soft_exceeded"
                      ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                      : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
                )}
              >
                {costStatus === "hard_exceeded"
                  ? "Cap reached"
                  : costStatus === "soft_exceeded"
                    ? "Near cap"
                    : "On track"}
              </span>
            </div>

            <div className="mt-3 mb-3 flex items-baseline gap-2">
              <span
                className={cn(
                  "text-2xl font-semibold tabular-nums",
                  costStatus === "hard_exceeded"
                    ? "text-[var(--error)]"
                    : costStatus === "soft_exceeded"
                      ? "text-[var(--warning)]"
                      : "text-[var(--text-primary)]",
                )}
              >
                ${costUsed.toFixed(2)}
              </span>
              <span className="text-sm tabular-nums text-[var(--text-secondary)]">
                / ${costHard.toFixed(2)}
              </span>
              {costSoft > 0 && costSoft < costHard && (
                <span className="ml-1 text-xs text-[var(--text-muted)]">
                  (warn ${costSoft.toFixed(2)})
                </span>
              )}
            </div>

            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-muted)]">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  costStatus === "hard_exceeded"
                    ? "bg-[var(--error)]"
                    : costStatus === "soft_exceeded"
                      ? "bg-[var(--warning)]"
                      : "bg-[var(--accent)]",
                )}
                style={{ width: `${costPct}%` }}
              />
            </div>
            <p className="mt-2 text-xs tabular-nums text-[var(--text-muted)]">
              {costPct.toFixed(0)}% of monthly cap
            </p>

            {costStatus === "hard_exceeded" && (
              <p className="mt-4 text-sm text-[var(--error)]">
                You&apos;ve hit your monthly free-tier spending cap. New spend-bearing
                requests will be blocked until next month, or until support raises
                your cap.
              </p>
            )}

            {!plan?.stripe_subscription_id && (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">
                Eden is currently free for everyone. Paid plans aren&apos;t available
                yet — if you need more headroom, use the button above and we&apos;ll
                raise your cap manually.
              </p>
            )}
          </SettingsCard>

          <SettingsCard
            title="Plan limits"
            description="Seat and reference quotas — informational; your hard cap is USD cost above."
          >
            <PlanLimitsDisplay
              seats_used={plan?.seats_used ?? 0}
              seats_limit={plan?.seats_limit ?? 0}
              references_used={plan?.references_used ?? 0}
              references_limit={plan?.references_limit ?? 0}
              jobs_used={plan?.jobs_used ?? 0}
              jobs_limit={plan?.jobs_limit ?? 0}
            />
          </SettingsCard>
        </>
      )}
    </div>
  );
}
