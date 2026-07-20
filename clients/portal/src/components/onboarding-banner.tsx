"use client";

/**
 * OnboardingBanner — resume chip when the personal product tour is incomplete.
 *
 * Driven by Clerk ``unsafeMetadata.edenTour`` (same source as the overlay).
 * Remains visible after Skip so users can resume or jump to API keys / docs.
 */

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, ExternalLink, X } from "lucide-react";
import { useTourProgress } from "@/hooks/use-tour-progress";
import { formatOnboardingProgress } from "@/lib/onboarding-progress";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { shouldShowTourBanner } from "@/lib/tour-progress";
import { PRODUCT_TOUR_STEPS } from "@/lib/product-tour";
import { Button } from "@/components/ui/button";

const SESSION_KEY = "eden:onboarding:banner-dismissed";

export function OnboardingBanner({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const { isLoaded, progress } = useTourProgress();
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  });

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
    stepId === "welcome" || stepId === "api-keys" || stepId === "install";
  const emphasizeApiKey = stepId === "welcome" || stepId === "api-keys";
  const emphasizeInstall = stepId === "install";

  function dismiss() {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(SESSION_KEY, "1");
    }
    setDismissed(true);
  }

  // Layout collapses this when the API-auth error banner is up (API cold).
  // Keep a compact resume chip so Skip / Esc still have a clear way back.
  if (collapsed) {
    return (
      <div
        role="region"
        aria-label="Onboarding progress"
        className="sticky top-14 z-20 border-b border-[var(--accent)]/25 bg-[var(--accent)]/5"
      >
        <div className="mx-auto flex max-w-7xl items-center gap-space-2 px-space-4 py-space-2 text-xs">
          <span className="min-w-0 truncate text-[var(--text-secondary)]">
            {progress?.status === "skipped" ? "Tour paused" : "Setup"} ·{" "}
            {progressView.label}
          </span>
          <Button asChild size="sm" className="ml-auto min-h-11 shrink-0">
            <Link href="/dashboard?onboarding=1">
              Resume tour
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Onboarding progress"
      className="sticky top-14 z-20 border-b border-[var(--accent)]/25 bg-[var(--accent)]/5"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-space-2 px-space-4 py-space-2 text-xs sm:text-sm">
        <span className="font-medium text-[var(--text-primary)] whitespace-nowrap">
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
        <div className="ml-auto flex shrink-0 items-center gap-space-2">
          {emphasizeApiKey && (
            <Button asChild size="sm" className="min-h-11">
              <Link href="/settings?tab=api-keys">
                Create API key
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </Button>
          )}
          {emphasizeInstall && (
            <Button asChild size="sm" className="min-h-11">
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Docs quickstart
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </Button>
          )}
          <Button
            asChild
            size="sm"
            variant={earlySetup ? "outline" : "ghost"}
            className="min-h-11"
          >
            <Link href="/dashboard?onboarding=1">
              {progress?.status === "skipped" ? "Resume tour" : "Continue tour"}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={dismiss}
            aria-label="Dismiss onboarding banner"
            className="min-h-11 min-w-11"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export { PRODUCT_TOUR_STEPS as ONBOARDING_V2_STEPS };
