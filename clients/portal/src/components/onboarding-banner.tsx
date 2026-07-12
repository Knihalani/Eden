"use client";

/**
 * OnboardingBanner — cold-start progress chip (LP-11 + portal polish).
 *
 * Single source of truth: the Cat-23 wizard state
 * (``onboardingApi`` / ``/orgs/.../onboarding/state``), aligned with
 * the 4-step wizard in ``onboarding/layout.tsx``:
 *   welcome → connect → install → done
 *
 * Visual: single-line chip (progress + Resume). Collapses when the
 * layout auth-error banner is showing so the viewport isn't stacked
 * with two sticky chrome bands.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Terminal, X } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import {
  onboardingApi,
  onboardingV2Api,
  type OnboardingState,
  type OnboardingV2State,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS: Array<{
  id: string;
  label: string;
  blurb: string;
  href: string;
}> = [
  { id: "welcome", label: "Welcome", blurb: "Get started with Eden", href: "/onboarding" },
  { id: "connect", label: "Connect repo", blurb: "Open an SDK integration PR", href: "/onboarding/connect" },
  { id: "install", label: "Install SDK", blurb: "Copy the snippet into your agent", href: "/onboarding/install" },
  { id: "done", label: "Done", blurb: "Explore the dashboard", href: "/onboarding/done" },
];

/** Map cat-23 / legacy step ids onto the simplified wizard order. */
function wizardStepIndex(step: string | null | undefined): number {
  const s = (step || "welcome").toLowerCase();
  if (s === "done") return 3;
  if (s === "install" || s === "install_sdk" || s === "wait" || s === "wait_for_pr") return 2;
  if (s === "connect" || s === "connect_github") return 1;
  // welcome | org_setup | org | unknown
  return 0;
}

const SESSION_KEY = "eden:onboarding:v2:dismissed";

export function OnboardingBanner({
  collapsed = false,
}: {
  /** When true (auth error banner visible), render nothing. */
  collapsed?: boolean;
}) {
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

    // Cat-23 wizard = SoT for step display.
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
        // If v2 is unreachable, still show banner from wizard state.
        if (!cancelled) setV2Meta({ source: "defaults", onboarding_v2_enabled: true });
      });

    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id]);

  if (collapsed) return null;
  if (!wizardState) return null;
  if (v2Meta?.source === "legacy" || v2Meta?.onboarding_v2_enabled === false) return null;
  if (dismissed) return null;

  const currentIdx = wizardStepIndex(wizardState.step);
  // Hide once the wizard is complete.
  if (currentIdx >= STEPS.length - 1 || wizardState.step === "done") return null;

  const current = STEPS[currentIdx] ?? STEPS[0];
  const totalCount = STEPS.length - 1; // exclude terminal "done" from progress denom

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
          Step {currentIdx + 1}/{totalCount}
        </span>
        <span className="text-[var(--text-muted)]" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate text-[var(--text-secondary)]">
          {current.label}
          <span className="hidden text-[var(--text-muted)] sm:inline"> — {current.blurb}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Link
            href={current.href}
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

export { STEPS as ONBOARDING_V2_STEPS };
