/**
 * Product tour — walks the core portal surfaces, then points at the
 * public docs quickstart.
 *
 * Wave 11: slimmed to 5 steps (welcome → key → install → traces → finish).
 * Home / Issues / Improve are mentioned on finish — not separate spotlight stops.
 * No overlapping chrome — OnboardingOverlay defers behind banners / ErrorState.
 */

import { DOCS_QUICKSTART_URL } from "@/lib/constants";

export { DOCS_QUICKSTART_URL };

/** Wave 11.5 — tour stays ≤5 steps; overlay defers behind chrome banners. */
export const WAVE11_TOUR_SLIM = true as const;

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
  /** Optional primary CTA (API keys, install, finish). */
  ctaLabel?: string;
  ctaHref?: string;
  /** When true, open ctaHref in a new tab. */
  ctaExternal?: boolean;
}

/**
 * Ordered tour: welcome → API keys → install → traces → finish.
 * Agents / repo connect is demoted to a soft mention on finish.
 */
export const PRODUCT_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    kind: "welcome",
    href: "/home",
    title: "Welcome to Eden",
    body: "Capture LLM calls, analyse failures, and ship reviewable fixes. This walkthrough is optional — Skip anytime and resume from the banner. It does not create a workspace; create or join a workspace under Settings → Workspace first if you need one.",
  },
  {
    id: "api-keys",
    kind: "nav",
    targetId: "api-keys",
    href: "/settings?tab=api-keys",
    title: "Create an API key",
    body: "Create an org API key and copy your org id under Settings. You need both before the gateway or SDK can send traces.",
    ctaLabel: "Create API key",
    ctaHref: "/settings?tab=api-keys",
  },
  {
    id: "install",
    kind: "nav",
    href: "/home",
    title: "Install the SDK",
    body: "Use the docs quickstart: gateway (base_url + X-Org-Id / X-Org-Api-Key) or eden-sdk / @eden-ai/sdk, then run eden-doctor (or python -m eden_sdk.doctor) to verify. Fill-in works when you are signed in.",
    ctaLabel: "Open docs quickstart",
    ctaHref: DOCS_QUICKSTART_URL,
    ctaExternal: true,
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
    id: "finish",
    kind: "finish",
    href: "/home",
    title: "You're ready",
    body: "Next: docs quickstart → send a test trace → open Traces. Day to day: Home for health, Issues for clustered failures, Improve for reviewable patches. Connecting a repo under Agents is optional when you want Eden to see your code.",
    ctaLabel: "Open docs quickstart",
    ctaHref: DOCS_QUICKSTART_URL,
    ctaExternal: true,
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
  if (s === "done") return PRODUCT_TOUR_TOTAL - 1;
  if (s === "welcome") return stepIndexById("welcome");
  if (s === "api-keys" || s === "api_keys" || s === "settings") {
    return stepIndexById("api-keys");
  }
  if (s === "install" || s === "install_sdk") return stepIndexById("install");
  if (s === "traces") return stepIndexById("traces");
  // Removed Wave 10 steps map to finish (or traces for dashboard).
  if (s === "dashboard") return PRODUCT_TOUR_TOTAL - 1;
  if (s === "issues" || s === "improve") return PRODUCT_TOUR_TOTAL - 1;
  if (s === "wait" || s === "wait_for_pr") return PRODUCT_TOUR_TOTAL - 1;
  // Agents / connect demoted — never resume mid-tour on Agents.
  if (s === "connect" || s === "connect_github" || s === "agents") {
    return PRODUCT_TOUR_TOTAL - 1;
  }
  if (s.startsWith("tour:")) {
    const id = s.slice(5);
    if (id === "agents" || id === "settings") {
      return id === "settings"
        ? stepIndexById("api-keys")
        : PRODUCT_TOUR_TOTAL - 1;
    }
    if (id === "dashboard" || id === "issues" || id === "improve") {
      return PRODUCT_TOUR_TOTAL - 1;
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
