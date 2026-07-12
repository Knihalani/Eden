/**
 * Onboarding progress — single source of truth for step counters.
 *
 * Cat-23 wizard state (`onboardingApi.step`) drives progress. Display
 * collapses the optional wait-for-PR URL into the install slot so every
 * surface shows the same denominator:
 *
 *   welcome → connect → install → done
 *   (wait / wait_for_pr → install slot, label overridden)
 *
 * Wizard routes may still visit `/onboarding/wait`; progress chrome
 * must not invent a separate "1 of 5" counter.
 */

export interface OnboardingProgressStep {
  id: "welcome" | "connect" | "install" | "done";
  label: string;
  blurb: string;
  href: string;
}

/** User-facing steps (done is terminal; excluded from "X of Y" denom). */
export const ONBOARDING_PROGRESS_STEPS: OnboardingProgressStep[] = [
  {
    id: "welcome",
    label: "Welcome",
    blurb: "Get started with Eden",
    href: "/onboarding",
  },
  {
    id: "connect",
    label: "Connect repo",
    blurb: "Open an SDK integration PR",
    href: "/onboarding/connect",
  },
  {
    id: "install",
    label: "Install SDK",
    blurb: "Copy the snippet into your agent",
    href: "/onboarding/install",
  },
  {
    id: "done",
    label: "Done",
    blurb: "Explore the dashboard",
    href: "/onboarding/done",
  },
];

/** Progress denominator — excludes terminal "done". */
export const ONBOARDING_PROGRESS_TOTAL = ONBOARDING_PROGRESS_STEPS.length - 1;

/**
 * Map cat-23 / legacy step ids onto the shared progress order.
 * Wait-for-PR collapses into the install slot.
 */
export function onboardingProgressIndex(
  step: string | null | undefined,
): number {
  const s = (step || "welcome").toLowerCase();
  if (s === "done") return 3;
  if (
    s === "install" ||
    s === "install_sdk" ||
    s === "wait" ||
    s === "wait_for_pr"
  ) {
    return 2;
  }
  if (s === "connect" || s === "connect_github") return 1;
  // welcome | org_setup | org | tour | autonomous | unknown
  return 0;
}

/** Map a wizard pathname onto the same progress order. */
export function onboardingProgressIndexFromPath(pathname: string): number {
  const path = (pathname || "").replace(/\/$/, "") || "/onboarding";
  if (path === "/onboarding/done") return 3;
  if (
    path === "/onboarding/install" ||
    path === "/onboarding/wait"
  ) {
    return 2;
  }
  if (path === "/onboarding/connect") return 1;
  return 0;
}

export function isWaitPath(pathname: string): boolean {
  const path = (pathname || "").replace(/\/$/, "");
  return path === "/onboarding/wait";
}

export function isOnboardingWizardPath(pathname: string | null | undefined): boolean {
  const path = pathname || "";
  return path === "/onboarding" || path.startsWith("/onboarding/");
}

export interface OnboardingProgressView {
  index: number;
  /** 1-based display step (capped at TOTAL). */
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
    ? onboardingProgressIndexFromPath(stepOrPath || "/onboarding")
    : onboardingProgressIndex(stepOrPath);
  const step =
    ONBOARDING_PROGRESS_STEPS[Math.min(index, ONBOARDING_PROGRESS_STEPS.length - 1)] ??
    ONBOARDING_PROGRESS_STEPS[0];
  const waiting =
    opts?.fromPath
      ? isWaitPath(stepOrPath || "")
      : ["wait", "wait_for_pr"].includes((stepOrPath || "").toLowerCase());

  return {
    index,
    current: Math.min(index + 1, ONBOARDING_PROGRESS_TOTAL),
    total: ONBOARDING_PROGRESS_TOTAL,
    label: waiting ? "Waiting for PR" : step.label,
    blurb: waiting
      ? "Merge the integration PR, then install the SDK"
      : step.blurb,
    href: waiting ? "/onboarding/wait" : step.href,
    isComplete: index >= ONBOARDING_PROGRESS_TOTAL || stepOrPath === "done",
  };
}
