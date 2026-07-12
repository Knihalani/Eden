"use client";

/**
 * OnboardingBanner — D.14 cold-start UX (upgradespec §10.2)
 *
 * Top-of-portal dismissable banner that surfaces the D.14
 * state-machine progress for new orgs (created on/after
 * 2026-07-01). Renders nothing for legacy orgs (the state
 * row returns ``source: "legacy"`` + ``onboarding_v2_enabled:
 * false``).
 *
 * Ponytail: best-effort. If the API is unreachable the banner
 * just doesn't render — never blocks the portal.
 *
 * Dismissal is per-session (sessionStorage) so the banner
 * stays out of the way while a user is actively working
 * without persisting across browser sessions.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Sparkles, X } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingV2Api, type OnboardingV2State } from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS: Array<{
  id: OnboardingV2State["current_step"];
  label: string;
  blurb: string;
}> = [
  { id: "connect", label: "Connect repo", blurb: "Open an SDK integration PR" },
  { id: "install", label: "Install SDK", blurb: "Copy the snippet into your agent" },
  { id: "wait", label: "First traces", blurb: "Send your first 10 traces" },
  { id: "done", label: "Explore", blurb: "Run judges and explore the dashboard" },
];

/** Map legacy/API step ids onto the simplified wizard order. */
function stepIndex(step: OnboardingV2State["current_step"]): number {
  if (step === "org") return 0;
  const idx = STEPS.findIndex((s) => s.id === step);
  return idx >= 0 ? idx : 0;
}

const SESSION_KEY = "eden:onboarding:v2:dismissed";

export function OnboardingBanner() {
  const { currentOrg } = useOrg();
  const [state, setState] = useState<OnboardingV2State | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setDismissed(window.sessionStorage.getItem(SESSION_KEY) === "1");
    }
    if (!currentOrg?.id) {
      setState(null);
      return;
    }
    onboardingV2Api
      .getState(currentOrg.id)
      .then((res) => setState(res.data))
      .catch(() => setState(null));
  }, [currentOrg?.id]);

  if (!state || !state.onboarding_v2_enabled) return null;
  if (state.source === "legacy") return null;
  if (dismissed) return null;
  if (state.current_step === "autonomous" || state.current_step === "tour") return null;

  const currentIdx = stepIndex(state.current_step);
  const current = STEPS[currentIdx] ?? STEPS[0];
  const completedCount = Math.min(state.completed_steps.length, STEPS.length);
  const totalCount = STEPS.length;

  function dismiss() {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(SESSION_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    // `sticky top-{topbar-height} z-20` so the banner stays visible
    // while scrolling, sitting just below the topbar (z-30). Without
    // the z-index, the sticky topbar (z-30) covers it on scroll.
    // `top-14` = 56px (matches the topbar's effective height with
    // its `py-3` + ~40px content). June 2026 layout-pass fix.
    <div
      role="region"
      aria-label="Onboarding progress"
      className="sticky top-14 z-20 border-b border-[var(--accent)]/30 bg-[var(--accent)]/5 backdrop-blur"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <Sparkles className="h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text-primary)]">
              Onboarding: step {currentIdx + 1} of {totalCount}
            </span>
            <span className="text-[var(--text-secondary)]">·</span>
            <span className="text-[var(--text-secondary)]">{current.label}</span>
            <span className="text-[var(--text-muted)]">— {current.blurb}</span>
          </div>
          <div className="mt-1 flex items-center gap-1">
            {STEPS.map((s, i) => {
              const done = i < currentIdx || state.completed_steps.includes(s.id);
              const active = i === currentIdx;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "h-1 flex-1 rounded-full",
                    done
                      ? "bg-[var(--accent)]"
                      : active
                      ? "bg-[var(--accent)]/50"
                      : "bg-[var(--bg-elev-2)]",
                  )}
                  aria-hidden="true"
                />
              );
            })}
            <span className="ml-2 text-xs text-[var(--text-muted)]">
              {completedCount}/{totalCount}
            </span>
          </div>
        </div>
        <Link
          href={
            currentIdx <= 0 ? "/onboarding/connect" :
            currentIdx === 1 ? "/onboarding/install" :
            "/onboarding"
          }
          className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
        >
          Resume
          <ChevronRight className="h-3 w-3" />
        </Link>
        <button
          onClick={dismiss}
          aria-label="Dismiss onboarding banner"
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export { STEPS as ONBOARDING_V2_STEPS };
