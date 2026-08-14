/**
 * Product tour — walks core portal surfaces, then Get started with
 * filled install snippets.
 */

import { DOCS_QUICKSTART_URL } from "@/lib/constants";

export { DOCS_QUICKSTART_URL };

export type TourStepKind = "welcome" | "nav" | "finish";

export interface TourStep {
  id: string;
  kind: TourStepKind;
  /** Sidebar / spotlight target (`data-tour-id`). */
  targetId?: string;
  /** Navigate here before showing the step (internal only). */
  href?: string;
  title: string;
  body: string;
}

/**
 * Ordered tour: welcome → home → traces → API keys → get-started.
 */
export const PRODUCT_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    kind: "welcome",
    href: "/home",
    title: "Welcome to Eden",
    body: "Capture LLM calls, analyze failures, and ship reviewable fixes. This walkthrough is optional — skip anytime.",
  },
  {
    id: "home",
    kind: "nav",
    targetId: "home",
    href: "/home",
    title: "Home",
    body: "Your org health at a glance — open issues, recent errors, and what to do next.",
  },
  {
    id: "traces",
    kind: "nav",
    targetId: "traces",
    href: "/traces",
    title: "Traces",
    body: "Your first events land here. Open a row to inspect spans, replay sessions, and dig into failures.",
  },
  {
    id: "api-keys",
    kind: "nav",
    targetId: "api-keys",
    href: "/settings?mode=keys",
    title: "API keys",
    body: "Org API keys live under Settings → API keys. Create a key only if you need one — nothing is minted until you ask.",
  },
  {
    id: "get-started",
    kind: "finish",
    href: "/home",
    title: "Get started",
    body: "Create a Quickstart key if you need one, copy a snippet, run doctor, then watch Traces for your first event.",
  },
];

export const PRODUCT_TOUR_TOTAL = PRODUCT_TOUR_STEPS.length;

/** Step ids that need a sidebar/settings `data-tour-id` spotlight. */
export const PRODUCT_TOUR_SPOTLIGHT_IDS: readonly string[] = PRODUCT_TOUR_STEPS.filter(
  (s) => s.targetId,
).map((s) => s.targetId as string);

function stepIndexById(id: string): number {
  const idx = PRODUCT_TOUR_STEPS.findIndex((t) => t.id === id);
  return idx >= 0 ? idx : 0;
}

/** Map legacy onboarding / old tour step names → tour index. */
export function tourIndexFromOnboardingStep(
  step: string | null | undefined,
): number {
  const s = (step || "welcome").toLowerCase();
  if (s === "done" || s === "get-started" || s === "finish") {
    return stepIndexById("get-started");
  }
  if (s === "welcome") return stepIndexById("welcome");
  if (s === "home" || s === "dashboard") return stepIndexById("home");
  if (s === "api-keys" || s === "api_keys" || s === "settings") {
    return stepIndexById("api-keys");
  }
  if (s === "install" || s === "install_sdk") {
    return stepIndexById("get-started");
  }
  if (s === "traces") return stepIndexById("traces");
  if (s === "issues" || s === "improve") return stepIndexById("get-started");
  if (s === "wait" || s === "wait_for_pr") return stepIndexById("get-started");
  if (s === "connect" || s === "connect_github" || s === "agents") {
    return stepIndexById("get-started");
  }
  if (s.startsWith("tour:")) {
    const id = s.slice(5);
    if (id === "agents" || id === "settings") {
      return id === "settings"
        ? stepIndexById("api-keys")
        : stepIndexById("get-started");
    }
    if (id === "dashboard" || id === "home") return stepIndexById("home");
    if (id === "issues" || id === "improve" || id === "install") {
      return stepIndexById("get-started");
    }
    const idx = PRODUCT_TOUR_STEPS.findIndex((t) => t.id === id);
    return idx >= 0 ? idx : 0;
  }
  return 0;
}

export function tourStepApiValue(index: number): string {
  const step = PRODUCT_TOUR_STEPS[Math.min(index, PRODUCT_TOUR_TOTAL - 1)];
  if (!step || step.kind === "finish") return "done";
  if (step.kind === "welcome") return "welcome";
  return `tour:${step.id}`;
}
