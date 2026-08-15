"use client";

/**
 * OnboardingBanner — resume chip when the personal product tour is incomplete.
 *
 * Driven by Clerk ``unsafeMetadata.edenTour`` (same source as the overlay).
 * Hidden while org is still resolving, while the live tour is open, and
 * when there is no workspace yet (avoids stacking with status banners).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, X } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useTourProgress } from "@/hooks/use-tour-progress";
import { formatOnboardingProgress } from "@/lib/onboarding-progress";
import {
  markTourBannerDismissed,
  shouldShowTourBanner,
} from "@/lib/tour-progress";
import { PRODUCT_TOUR_STEPS } from "@/lib/product-tour";
import { Button } from "@/components/ui/button";

export function OnboardingBanner({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const { currentOrg, loading: orgLoading, orgSyncing } = useOrg();
  const { isLoaded, progress } = useTourProgress();
  const [dismissed, setDismissed] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  useEffect(() => {
    const on = () => setTourOpen(true);
    const off = () => setTourOpen(false);
    window.addEventListener("eden:product-tour", on);
    window.addEventListener("eden:product-tour-end", off);
    return () => {
      window.removeEventListener("eden:product-tour", on);
      window.removeEventListener("eden:product-tour-end", off);
    };
  }, []);

  if (orgLoading || orgSyncing || !currentOrg) return null;
  if (tourOpen) return null;
  if (!isLoaded) return null;
  if (!shouldShowTourBanner(progress)) return null;
  if (dismissed) return null;

  const stepId =
    progress?.status === "active" || progress?.status === "skipped"
      ? PRODUCT_TOUR_STEPS[progress.stepIndex]?.id
      : "welcome";
  const progressView = formatOnboardingProgress(
    stepId ? `tour:${stepId}` : "welcome",
  );

  const earlySetup =
    stepId === "welcome" ||
    stepId === "api-keys" ||
    stepId === "get-started";
  const emphasizeApiKey = stepId === "welcome" || stepId === "api-keys";

  function dismiss() {
    markTourBannerDismissed();
    setDismissed(true);
  }

  if (collapsed) {
    return (
      <div
        role="region"
        aria-label="Onboarding progress"
        className="sticky top-0 z-20 border-b border-[color-mix(in_srgb,var(--accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
      >
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-xs">
          <span className="min-w-0 truncate text-[var(--text-secondary)]">
            {progress?.status === "skipped" ? "Tour paused" : "Setup"} ·{" "}
            {progressView.label}
          </span>
          <Link
            href="/home?onboarding=1"
            className="ds-btn ds-btn-primary ds-btn-sm ml-auto min-h-11 shrink-0"
          >
            Resume tour
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Onboarding progress"
      className="sticky top-0 z-20 border-b border-[color-mix(in_srgb,var(--accent)_25%,transparent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-xs sm:text-sm">
        <span className="whitespace-nowrap font-medium text-[var(--text-primary)]">
          {progress?.status === "skipped" ? "Tour paused" : "Setup"}{" "}
          {progressView.current}/{progressView.total}
        </span>
        <span className="text-[var(--text-muted)]" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate text-[var(--text-secondary)]">
          {progressView.label}
          <span className="hidden text-[var(--text-muted)] sm:inline">
            {" "}
            —{" "}
            {earlySetup
              ? "API key → install → first trace"
              : progressView.blurb}
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {emphasizeApiKey ? (
            <Link
              href="/settings?mode=keys"
              className="ds-btn ds-btn-primary ds-btn-sm min-h-11"
            >
              Create API key
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : null}
          <Link
            href="/home?onboarding=1"
            className={
              earlySetup
                ? "ds-btn ds-btn-outline ds-btn-sm min-h-11"
                : "ds-btn ds-btn-ghost ds-btn-sm min-h-11"
            }
          >
            {progress?.status === "skipped" ? "Resume tour" : "Continue tour"}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={dismiss}
            aria-label="Dismiss onboarding banner"
            className="min-h-11 min-w-11 !px-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export { PRODUCT_TOUR_STEPS as ONBOARDING_V2_STEPS };
