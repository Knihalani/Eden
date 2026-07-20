"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { Loader2, AlertCircle, Check, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  featureGatedErrorCopy,
  isPaidPlansDisabledError,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";
import {
  type BillingUsage,
} from "./billing-types";

interface BillingOverviewProps {
  variant?: "page" | "embedded";
}

export function BillingOverview({ variant = "page" }: BillingOverviewProps) {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<unknown | null>(null);
  // ``api.getPlans`` returns a wider shape than BillingUsage; cast at
  // the assignment site to bridge the gap (same reason as
  // billing-tab.tsx — kept UI types as read-side contracts).
  const [usage, setUsage] = useState<Partial<BillingUsage> | null>(null);

  const loadData = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setFetchError(null);
    try {
      // Ponytail: only ``/billing/plans`` matters in free-only mode.
      // Do not swallow failures into a false $0 healthy card.
      const usageData = await api.getPlans(currentOrg.id);
      setUsage(usageData as Partial<BillingUsage>);
    } catch (err) {
      console.error("Failed to load billing data", err);
      setUsage(null);
      setFetchError(err);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    if (currentOrg) {
      loadData();
    }
  }, [currentOrg, loadData]);

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

  const costUsed = usage?.cost_used_usd ?? 0;
  const costSoft = usage?.cost_soft_limit_usd ?? 0;
  const costHard = usage?.cost_hard_limit_usd ?? 0;
  const costPct =
    costHard > 0 ? Math.min(100, (costUsed / costHard) * 100) : 0;
  const costStatus = usage?.cost_status ?? "ok";
  const errorCopy = fetchError
    ? featureGatedErrorCopy(fetchError, "Could not load billing data")
    : null;
  const freeOnlyError = fetchError
    ? isPaidPlansDisabledError(fetchError)
    : false;
  // Don't paint a false-healthy $0 card when plans failed to load.
  const showUsage = usage != null && !fetchError;

  return (
    <div className={cn(variant === "page" ? "space-y-8" : "space-y-6")}>
      {errorCopy && (
        <div
          role="status"
          className={cn(
            "p-4 rounded-xl border text-sm flex items-start justify-between gap-3",
            freeOnlyError
              ? "border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              : "border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]",
          )}
        >
          <div className="flex items-start gap-2 min-w-0">
            {freeOnlyError ? (
              <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            )}
            <div className="min-w-0">
              <p className="font-medium text-[var(--text-primary)]">{errorCopy.title}</p>
              <p className="mt-0.5">{errorCopy.message}</p>
            </div>
          </div>
          {fetchError && isRetryableIntelligenceError(fetchError) && (
            <button
              type="button"
              onClick={() => loadData()}
              className="font-medium underline shrink-0"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {showUsage && (
      <>
      {/* Primary card: spend this month vs cap */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Spending this month
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              {usage?.display_name ?? "Free"} plan · resets monthly
            </p>
          </div>
          <span
            className={cn(
              "px-3 py-1 text-sm font-medium rounded-full capitalize",
              costStatus === "hard_exceeded"
                ? "bg-[var(--error-bg)] text-[var(--error)]"
                : costStatus === "soft_exceeded"
                  ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                  : "bg-[var(--success-bg)] text-[var(--success)]"
            )}
          >
            {costStatus === "hard_exceeded"
              ? "Cap reached"
              : costStatus === "soft_exceeded"
                ? "Near cap"
                : "Healthy"}
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
          <span className="text-sm text-[var(--text-muted)] tabular-nums">
            / ${costHard.toFixed(2)} cap
          </span>
          {costSoft > 0 && costSoft < costHard && (
            <span className="text-xs text-[var(--text-muted)] ml-2">
              (soft warning at ${costSoft.toFixed(2)})
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              costStatus === "hard_exceeded"
                ? "bg-[var(--error)]"
                : costStatus === "soft_exceeded"
                  ? "bg-[var(--warning)]"
                  : "bg-[var(--accent)]"
            )}
            style={{ width: `${costPct}%` }}
          />
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-2 tabular-nums">
          {costPct.toFixed(1)}% of monthly cap used
        </p>

        {costStatus === "hard_exceeded" && (
          <div className="mt-4 p-3 rounded-lg bg-[var(--error-bg)] border border-[var(--error)]/30 text-sm text-[var(--error)]">
            You&apos;ve hit your monthly free-tier spending cap. New spend-bearing
            requests will be blocked until next month, or until support raises
            your cap.
          </div>
        )}
        {costStatus === "soft_exceeded" && (
          <div className="mt-4 p-3 rounded-lg bg-[var(--warning-bg)] border border-[var(--warning)]/30 text-sm text-[var(--warning)] flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            You&apos;re past the soft warning threshold. Heavy usage from here on
            will be blocked once you reach the cap.
          </div>
        )}
      </div>

      {/* Resource breakdown — informational only */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-1">
          Resource breakdown
        </h2>
        <p className="text-sm text-[var(--text-muted)] mb-4">
          Where the spend came from this month. These are informational — your
          cap is on total USD cost above.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ResourceRow
            label="LLM tokens"
            used={usage?.tokens_used ?? 0}
            unit="tokens"
          />
          <ResourceRow
            label="Sandbox compute"
            used={usage?.sandbox_seconds_used ?? 0}
            unit="seconds"
            decimals={1}
          />
          <ResourceRow
            label="Storage held"
            used={usage?.storage_mb_used ?? 0}
            unit="MB"
            decimals={1}
          />
          <ResourceRow
            label="Seats"
            used={usage?.seats_used ?? 0}
            limit={usage?.seats_limit ?? 0}
            unit="members"
          />
          <ResourceRow
            label="Code references"
            used={usage?.references_used ?? 0}
            limit={usage?.references_limit ?? 0}
            unit="refs"
          />
        </div>
      </div>
      </>
      )}

      {/* Free plan notice — always shown in free-only; explains intentional dormancy */}
      {(!fetchError || freeOnlyError) && (
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <div className="flex items-start gap-3">
          <Check className="w-5 h-5 text-[var(--success)] flex-shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              You&apos;re on the Free plan
            </h2>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Eden is currently free for everyone. Your cap is on the total USD
              cost Eden incurs running your workloads this month (LLM tokens,
              sandbox compute, storage) — so heavy traffic automatically slows
              rather than surprise-billing you. Paid plans aren&apos;t available
              yet; if you need more headroom, reach out and we&apos;ll raise
              your cap manually.
            </p>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

function ResourceRow({
  label,
  used,
  limit,
  unit,
  decimals = 0,
}: {
  label: string;
  used: number;
  limit?: number;
  unit: string;
  decimals?: number;
}) {
  const fmt = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

  return (
    <div className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] rounded-lg">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <span className="text-sm font-medium text-[var(--text-primary)] tabular-nums">
        {fmt(used)} {unit}
        {typeof limit === "number" && limit > 0 ? (
          <span className="text-[var(--text-muted)]"> / {fmt(limit)}</span>
        ) : null}
      </span>
    </div>
  );
}