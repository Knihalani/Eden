"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface IntegrationUnavailableBannerProps {
  label: string;
  message: string | null;
  onRetry?: () => void;
  className?: string;
}

/**
 * Persistent warning when a third-party integration is not wired on
 * this Eden instance. Distinct from transient ErrorState — this is
 * expected when STRIPE_SECRET_KEY / GitHub App / etc. are absent.
 */
export function IntegrationUnavailableBanner({
  label,
  message,
  onRetry,
  className,
}: IntegrationUnavailableBannerProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning-bg)] p-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle
          className="h-5 w-5 shrink-0 text-[var(--warning)] mt-0.5"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {label} unavailable
          </p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {message ??
              "This feature is not configured on this Eden instance. Contact your administrator."}
          </p>
        </div>
      </div>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="min-h-[44px] shrink-0 self-start"
          aria-label={`Retry checking ${label} status`}
        >
          <RefreshCw className="h-4 w-4 mr-1.5" aria-hidden />
          Retry
        </Button>
      )}
    </div>
  );
}
