"use client";

/**
 * OnboardingBanner — cold-start progress chip (single SoT).
 *
 * Progress comes from ``lib/onboarding-progress`` (Cat-23 wizard
 * state via ``onboardingApi``). Hidden on ``/onboarding/*`` so the
 * wizard chrome is the only step counter inside the flow — no dual
 * "1 of 5" / "1 of 3" stacks.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Terminal, X } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import {
  onboardingApi,
  onboardingV2Api,
  type OnboardingState,
  type OnboardingV2State,
} from "@/lib/api";
import {
  formatOnboardingProgress,
  isOnboardingWizardPath,
  ONBOARDING_PROGRESS_STEPS,
} from "@/lib/onboarding-progress";
import { cn } from "@/lib/utils";

const SESSION_KEY = "eden:onboarding:v2:dismissed";

export function OnboardingBanner({
  collapsed = false,
}: {
  /** When true (auth error banner visible), render nothing. */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { currentOrg } = useOrg();
  const [wizardState, setWizardState] = useState<OnboardingState | null>(null);
  const [v2Meta, setV2Meta] = useState<Pick<OnboardingV2State, "source" | "onboarding_v2_enabled"> | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setDismissed(window.sessionStorage.getItem(SESSION_KEY) === "1");
    }
    if (!currentOrg?.id) {
      setWizardState(null);
      setV2Meta(null);
      return;
    }
    const orgId = currentOrg.id;
    let cancelled = false;

    onboardingApi
      .getState(orgId)
      .then((res) => {
        if (!cancelled) setWizardState(res);
      })
      .catch(() => {
        if (!cancelled) setWizardState(null);
      });

    // v2 only gates legacy vs new-org banner visibility.
    onboardingV2Api
      .getState(orgId)
      .then((res) => {
        if (cancelled || !res?.data) return;
        setV2Meta({
          source: res.data.source,
          onboarding_v2_enabled: res.data.onboarding_v2_enabled,
        });
      })
      .catch(() => {
        if (!cancelled) setV2Meta({ source: "defaults", onboarding_v2_enabled: true });
      });

    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id]);

  // Wizard routes own their progress strip — don't stack a second counter.
  if (isOnboardingWizardPath(pathname)) return null;
  if (collapsed) return null;
  if (!wizardState) return null;
  if (v2Meta?.source === "legacy" || v2Meta?.onboarding_v2_enabled === false) return null;
  if (dismissed) return null;

  const progress = formatOnboardingProgress(wizardState.step);
  if (progress.isComplete) return null;

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
        <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <span className="font-medium text-[var(--text-primary)] whitespace-nowrap">
          Step {progress.current}/{progress.total}
        </span>
        <span className="text-[var(--text-muted)]" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate text-[var(--text-secondary)]">
          {progress.label}
          <span className="hidden text-[var(--text-muted)] sm:inline"> — {progress.blurb}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Link
            href={progress.href}
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md border border-[var(--accent)]/40",
              "bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]",
              "hover:bg-[var(--accent)]/20",
            )}
          >
            Resume
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

export { ONBOARDING_PROGRESS_STEPS as ONBOARDING_V2_STEPS };
