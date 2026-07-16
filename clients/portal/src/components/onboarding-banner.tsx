"use client";

/**
 * OnboardingBanner — resume chip when the personal product tour is incomplete.
 *
 * Driven by Clerk ``unsafeMetadata.edenTour`` (same source as the overlay).
 */

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Terminal, X } from "lucide-react";
import { useTourProgress } from "@/hooks/use-tour-progress";
import {
  formatOnboardingProgress,
  isOnboardingWizardPath,
} from "@/lib/onboarding-progress";
import { PRODUCT_TOUR_STEPS } from "@/lib/product-tour";
import { cn } from "@/lib/utils";

const SESSION_KEY = "eden:onboarding:banner-dismissed";

export function OnboardingBanner({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { isLoaded, progress, isComplete } = useTourProgress();
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  });

  if (!isLoaded) return null;
  if (isOnboardingWizardPath(pathname)) return null;
  if (collapsed) return null;
  if (isComplete) return null;
  if (dismissed) return null;

  const stepId =
    progress?.status === "active"
      ? PRODUCT_TOUR_STEPS[progress.stepIndex]?.id
      : "welcome";
  const progressView = formatOnboardingProgress(
    stepId ? `tour:${stepId}` : "welcome",
  );

  function dismiss() {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(SESSION_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Onboarding progress"
      className="sticky top-14 z-20 border-b border-[var(--accent)]/25 bg-[var(--accent)]/5 backdrop-blur"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-1.5 text-xs sm:text-sm">
        <Terminal
          className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
          aria-hidden
        />
        <span className="font-medium text-[var(--text-primary)] whitespace-nowrap">
          Step {progressView.current}/{progressView.total}
        </span>
        <span className="text-[var(--text-muted)]" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate text-[var(--text-secondary)]">
          {progressView.label}
          <span className="hidden text-[var(--text-muted)] sm:inline">
            {" "}
            — {progressView.blurb}
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Link
            href="/dashboard?onboarding=1"
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md border border-[var(--accent)]/40",
              "bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]",
              "hover:bg-[var(--accent)]/20",
            )}
          >
            Resume tour
            <ChevronRight className="h-3 w-3" aria-hidden />
          </Link>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss onboarding banner"
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text-primary)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export { PRODUCT_TOUR_STEPS as ONBOARDING_V2_STEPS };
