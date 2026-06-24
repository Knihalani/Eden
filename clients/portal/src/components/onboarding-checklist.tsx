"use client";

/**
 * OnboardingChecklist — D.14 cold-start UX 7-step progress card.
 *
 * Renders the spec's 7-step checklist (per §10.1) with
 * completed / active / pending states. Used on the
 * /onboarding page and any other surface that wants to
 * surface the org's progress through the cold-start UX.
 *
 * The component is read-only (the underlying state machine
 * is mutated by the API on the actual step pages; the
 * checklist re-fetches on focus to stay in sync).
 */

import { useEffect, useState } from "react";
import { Check, Circle, Loader2, Lock } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingV2Api, type OnboardingV2State } from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS: Array<{
  id: OnboardingV2State["current_step"];
  label: string;
  description: string;
}> = [
  {
    id: "install",
    label: "Install the SDK",
    description: "Drop the SDK into your agent code.",
  },
  {
    id: "org",
    label: "Set up your organisation",
    description: "Configure your workspace + invite teammates.",
  },
  {
    id: "connect",
    label: "Connect a source",
    description: "Connect a repo (admins) or paste an API key.",
  },
  {
    id: "wait",
    label: "Wait for your first 10 traces",
    description: "Triggers automatically once 10 traces land.",
  },
  {
    id: "done",
    label: "Get your first judge score",
    description: "Triggers automatically once a judge runs.",
  },
  {
    id: "tour",
    label: "Save your first prompt version",
    description: "Triggers automatically once a version is saved.",
  },
  {
    id: "autonomous",
    label: "Enable autonomous mode",
    description: "Self-healing code modification opt-in.",
  },
];

export function OnboardingChecklist() {
  const { currentOrg } = useOrg();
  const [state, setState] = useState<OnboardingV2State | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg?.id) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    onboardingV2Api
      .getState(currentOrg.id)
      .then((res) => setState(res.data))
      .catch(() => setState(null))
      .finally(() => setLoading(false));
  }, [currentOrg?.id]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading onboarding state…
      </div>
    );
  }
  if (!state || !state.onboarding_v2_enabled) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4 text-sm text-[var(--text-muted)]">
        Onboarding checklist is unavailable for this org (legacy
        workspace — created before the 2026-07-01 v2 rollout).
      </div>
    );
  }

  const currentIdx = STEPS.findIndex((s) => s.id === state.current_step);

  return (
    <ol className="space-y-2">
      {STEPS.map((step, i) => {
        const done = i < currentIdx || state.completed_steps.includes(step.id);
        const active = i === currentIdx;
        const blocked = i > currentIdx + 1; // skip-blocked (per spec test)
        return (
          <li
            key={step.id}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3 transition-colors",
              done
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/5"
                : active
                ? "border-[var(--accent)] bg-[var(--bg-elev-1)]"
                : "border-[var(--border-default)] bg-[var(--bg-elev-1)]",
            )}
          >
            <div
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
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
              <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                {step.description}
              </div>
            </div>
            {active && (
              <span className="rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                In progress
              </span>
            )}
            {done && (
              <span className="rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                Done
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export { STEPS as ONBOARDING_CHECKLIST_STEPS };
