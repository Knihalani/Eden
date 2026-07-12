"use client";

/**
 * OnboardingChecklist — cold-start progress card aligned with the
 * Cat-23 wizard SoT (LP-11 / OnboardingBanner):
 *   welcome → connect → install → done
 *
 * Uses ``onboardingApi`` (same machine as the banner). The D.14 v2
 * 7-step vocabulary is intentionally not rendered here so the
 * checklist cannot disagree with the banner.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Circle, Loader2, Lock } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi, type OnboardingState } from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS: Array<{
  id: string;
  label: string;
  description: string;
  href: string;
}> = [
  {
    id: "welcome",
    label: "Welcome",
    description: "Get started with Eden.",
    href: "/onboarding",
  },
  {
    id: "connect",
    label: "Connect a repo",
    description: "Open an SDK integration PR (optional for members).",
    href: "/onboarding/connect",
  },
  {
    id: "install",
    label: "Install the SDK",
    description: "Copy the configure snippet into your agent.",
    href: "/onboarding/install",
  },
  {
    id: "done",
    label: "Done",
    description: "Explore the dashboard and traces.",
    href: "/onboarding/done",
  },
];

/** Map cat-23 / legacy step ids onto the simplified wizard order. */
function wizardStepIndex(step: string | null | undefined): number {
  const s = (step || "welcome").toLowerCase();
  if (s === "done") return 3;
  if (s === "install" || s === "install_sdk" || s === "wait" || s === "wait_for_pr") return 2;
  if (s === "connect" || s === "connect_github") return 1;
  return 0;
}

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
      <div className="flex items-center gap-2 p-6 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading onboarding state…
      </div>
    );
  }
  if (!state) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4 text-sm text-[var(--text-muted)]">
        Onboarding checklist is unavailable right now.
      </div>
    );
  }

  const currentIdx = wizardStepIndex(state.step);

  return (
    <ol className="space-y-2">
      {STEPS.map((step, i) => {
        const done = i < currentIdx || state.step === "done";
        const active = i === currentIdx && state.step !== "done";
        const blocked = i > currentIdx + 1;
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
              <Link
                href={step.href}
                className="rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)] hover:bg-[var(--accent)]/30"
              >
                Resume
              </Link>
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
