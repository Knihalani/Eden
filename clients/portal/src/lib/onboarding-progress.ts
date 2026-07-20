/**
 * Onboarding progress — product tour resume chip + legacy step mapping.
 */

import {
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_TOTAL,
  tourIndexFromOnboardingStep,
} from "@/lib/product-tour";

export interface OnboardingProgressStep {
  id: string;
  label: string;
  blurb: string;
  href: string;
}

export const ONBOARDING_PROGRESS_STEPS: OnboardingProgressStep[] =
  PRODUCT_TOUR_STEPS.map((s) => ({
    id: s.id,
    label: s.title,
    blurb: s.body.slice(0, 80) + (s.body.length > 80 ? "…" : ""),
    href: "/dashboard?onboarding=1",
  }));

export const ONBOARDING_PROGRESS_TOTAL = PRODUCT_TOUR_TOTAL;

export function onboardingProgressIndex(
  step: string | null | undefined,
): number {
  return tourIndexFromOnboardingStep(step);
}

/** Legacy path helper — onboarding routes redirect to tour overlay. */
export function onboardingProgressIndexFromPath(pathname: string): number {
  const path = (pathname || "").replace(/\/$/, "") || "/dashboard";
  if (path.includes("/settings")) return tourIndexFromOnboardingStep("api-keys");
  if (path.includes("/traces")) return tourIndexFromOnboardingStep("traces");
  if (path.includes("/issues")) return tourIndexFromOnboardingStep("issues");
  if (path.includes("/improve")) return tourIndexFromOnboardingStep("improve");
  if (path.includes("install")) return tourIndexFromOnboardingStep("install");
  if (path.includes("wait") || path.includes("connect") || path.includes("done")) {
    return PRODUCT_TOUR_TOTAL - 1;
  }
  if (path.includes("/dashboard")) return tourIndexFromOnboardingStep("dashboard");
  return 0;
}

export interface OnboardingProgressView {
  index: number;
  current: number;
  total: number;
  label: string;
  blurb: string;
  href: string;
  isComplete: boolean;
}

export function formatOnboardingProgress(
  stepOrPath: string | null | undefined,
  opts?: { fromPath?: boolean },
): OnboardingProgressView {
  const index = opts?.fromPath
    ? onboardingProgressIndexFromPath(stepOrPath || "/dashboard")
    : onboardingProgressIndex(stepOrPath);
  const step =
    PRODUCT_TOUR_STEPS[Math.min(index, PRODUCT_TOUR_TOTAL - 1)] ??
    PRODUCT_TOUR_STEPS[0];
  const done = (stepOrPath || "").toLowerCase() === "done";

  return {
    index,
    current: Math.min(index + 1, PRODUCT_TOUR_TOTAL),
    total: PRODUCT_TOUR_TOTAL,
    label: step.title,
    blurb: step.body.slice(0, 72) + (step.body.length > 72 ? "…" : ""),
    href: "/dashboard?onboarding=1",
    isComplete: done,
  };
}
