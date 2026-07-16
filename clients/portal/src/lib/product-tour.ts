/**
 * Product tour — walks the core portal surfaces, then points at the
 * public docs quickstart.
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
  /** Optional primary CTA on finish. */
  ctaLabel?: string;
  ctaHref?: string;
}

/** Ordered tour: welcome → core nav surfaces → finish with docs. */
export const PRODUCT_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    kind: "welcome",
    href: "/dashboard",
    title: "Welcome to Eden",
    body: "A short walk through where you watch agents, catch failures, and ship fixes. Skip anytime — resume from the banner.",
  },
  {
    id: "dashboard",
    kind: "nav",
    targetId: "dashboard",
    href: "/dashboard",
    title: "Dashboard",
    body: "Health, recent traces, cost, and alerts at a glance. Start here when you open Eden.",
  },
  {
    id: "agents",
    kind: "nav",
    targetId: "agents",
    href: "/agents",
    title: "Agents",
    body: "Register and manage the agents you observe. Connect a repo when you want Eden to see your code.",
  },
  {
    id: "traces",
    kind: "nav",
    targetId: "traces",
    href: "/traces",
    title: "Traces",
    body: "Every AI call in one explorer. Open a row to inspect spans, replay sessions, and dig into failures.",
  },
  {
    id: "issues",
    kind: "nav",
    targetId: "issues",
    href: "/issues",
    title: "Issues",
    body: "Grouped failures and incident clusters — triage and heal instead of chasing one-off errors.",
  },
  {
    id: "improve",
    kind: "nav",
    targetId: "improve",
    href: "/improve",
    title: "Improve",
    body: "The action queue: patches, plans, and sweep history. Approve changes that close the loop.",
  },
  {
    id: "settings",
    kind: "nav",
    targetId: "settings",
    href: "/settings?tab=api-keys",
    title: "API keys",
    body: "Create an org API key under Settings. Or use Fill in on the docs quickstart when you are signed in.",
  },
  {
    id: "finish",
    kind: "finish",
    href: "/settings?tab=api-keys",
    title: "You're ready",
    body: "Grab an API key, then follow the docs quickstart to send your first trace. The SDK defaults to api.edenobservability.com.",
    ctaLabel: "Open docs quickstart",
    ctaHref: DOCS_QUICKSTART_URL,
  },
];

export const PRODUCT_TOUR_TOTAL = PRODUCT_TOUR_STEPS.length;

/** Map legacy Cat-23 step names → tour index. */
export function tourIndexFromOnboardingStep(
  step: string | null | undefined,
): number {
  const s = (step || "welcome").toLowerCase();
  if (s === "done") return PRODUCT_TOUR_TOTAL - 1;
  if (s === "install" || s === "install_sdk" || s === "wait" || s === "wait_for_pr") {
    return PRODUCT_TOUR_TOTAL - 1;
  }
  if (s === "connect" || s === "connect_github") return 1;
  if (s.startsWith("tour:")) {
    const id = s.slice(5);
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
