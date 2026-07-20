"use client";

/**
 * OnboardingChecklist — optional progress list for non-wizard surfaces.
 *
 * Uses the same ``lib/onboarding-progress`` SoT as the banner + tour.
 * Not rendered inside the tour welcome step (avoids dual counters).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Circle, Loader2, Lock } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi, type OnboardingState } from "@/lib/api";
import {
  formatOnboardingProgress,
  ONBOARDING_PROGRESS_STEPS,
} from "@/lib/onboarding-progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function OnboardingChecklist() {
  const { currentOrg } = useOrg();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg?.id) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    onboardingApi
      .getState(currentOrg.id)
      .then((res) => setState(res))
      .catch(() => setState(null))
      .finally(() => setLoading(false));
  }, [currentOrg?.id]);

  if (loading) {
    return (
      <div className="flex items-center gap-space-2 p-space-6 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading onboarding state…
      </div>
    );
  }
  if (!state) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-space-4 text-sm text-[var(--text-muted)]">
        Onboarding checklist is unavailable right now.
      </div>
    );
  }

  const progress = formatOnboardingProgress(state.step);
  const currentIdx = progress.index;

  return (
    <ol className="space-y-space-2">
      {ONBOARDING_PROGRESS_STEPS.map((step, i) => {
        const done = i < currentIdx || state.step === "done";
        const active = i === currentIdx && state.step !== "done";
        const blocked = i > currentIdx + 1;
        return (
          <li
            key={step.id}
            className={cn(
              "flex items-start gap-space-3 rounded-lg border p-space-3 transition-colors",
              done
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/5"
                : active
                ? "border-[var(--accent)] bg-[var(--bg-elev-1)]"
                : "border-[var(--border-default)] bg-[var(--bg-elev-1)]",
            )}
          >
            <div
              className={cn(
                "mt-space-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                done
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : active
                  ? "border border-[var(--accent)] text-[var(--accent)]"
                  : "border border-[var(--border-default)] text-[var(--text-muted)]",
              )}
            >
              {done ? (
                <Check className="h-3.5 w-3.5" />
              ) : blocked ? (
                <Lock className="h-3 w-3" />
              ) : (
                <Circle className="h-3 w-3" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "text-sm font-medium",
                  done || active
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-muted)]",
                )}
              >
                {i + 1}. {step.label}
              </div>
              <div className="mt-space-1 text-xs text-[var(--text-muted)]">
                {step.blurb}
              </div>
            </div>
            {active && (
              <Button asChild size="sm" variant="outline" className="min-h-11 shrink-0">
                <Link href={step.href}>Resume</Link>
              </Button>
            )}
            {done && (
              <span className="rounded-md bg-[var(--accent)]/10 px-space-2 py-space-1 text-2xs font-medium uppercase tracking-wide text-[var(--accent)]">
                Done
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export { ONBOARDING_PROGRESS_STEPS as ONBOARDING_CHECKLIST_STEPS };
