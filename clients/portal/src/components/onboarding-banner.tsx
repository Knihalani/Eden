"use client";

/**
 * OnboardingBanner — resume chip when the personal product tour is incomplete.
 *
 * Driven by Clerk ``unsafeMetadata.edenTour`` (same source as the overlay).
 * Remains visible after Skip so users can resume or jump to API keys / docs.
 */

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, ExternalLink, X } from "lucide-react";
import { useTourProgress } from "@/hooks/use-tour-progress";
import {
  formatOnboardingProgress,
  isOnboardingWizardPath,
} from "@/lib/onboarding-progress";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { shouldShowTourBanner } from "@/lib/tour-progress";
import { PRODUCT_TOUR_STEPS } from "@/lib/product-tour";
import { cn } from "@/lib/utils";

const SESSION_KEY = "eden:onboarding:banner-dismissed";

const chipBase =
  "inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]";

export function OnboardingBanner({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { isLoaded, progress } = useTourProgress();
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  });

  if (!isLoaded) return null;
  if (isOnboardingWizardPath(pathname)) return null;
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
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-1.5 text-xs">
          <span className="min-w-0 truncate text-[var(--text-secondary)]">
            {progress?.status === "skipped" ? "Tour paused" : "Setup"} ·{" "}
            {progressView.label}
          </span>
          <Link
            href="/dashboard?onboarding=1"
            className={cn(
              chipBase,
              "ml-auto shrink-0 bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90",
            )}
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
      className="sticky top-14 z-20 border-b border-[var(--accent)]/25 bg-[var(--accent)]/5"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-xs sm:text-sm">
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
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {emphasizeApiKey && (
            <Link
              href="/settings?tab=api-keys"
              className={cn(
                chipBase,
                "bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90",
              )}
            >
              Create API key
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
          {emphasizeInstall && (
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                chipBase,
                "bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90",
              )}
            >
              Docs quickstart
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
          <Link
            href="/dashboard?onboarding=1"
            className={cn(
              chipBase,
              earlySetup
                ? "border border-[var(--accent)]/40 bg-transparent font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10"
                : "bg-[var(--accent)]/10 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20",
            )}
          >
            {progress?.status === "skipped" ? "Resume tour" : "Continue tour"}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss onboarding banner"
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-muted)]",
              "hover:bg-[var(--bg-elev-2)] hover:text-[var(--text-primary)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]",
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export { PRODUCT_TOUR_STEPS as ONBOARDING_V2_STEPS };
