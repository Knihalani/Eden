/**
 * Product tour — walks the 12 consolidated portal surfaces, then
 * points at the public docs quickstart.
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

/** Ordered tour: welcome → each nav surface → finish with docs. */
export const PRODUCT_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    kind: "welcome",
    href: "/dashboard",
    title: "Welcome to Eden",
    body: "A quick tour of the portal — where to watch agents, catch failures, and ship improvements. Skip anytime; you can resume from the banner.",
  },
  {
    id: "dashboard",
    kind: "nav",
    targetId: "dashboard",
    href: "/dashboard",
    title: "Dashboard",
    body: "Your home base. Health, recent traces, cost, and alerts at a glance — start here when you open Eden.",
  },
  {
    id: "agents",
    kind: "nav",
    targetId: "agents",
    href: "/agents",
    title: "Agents",
    body: "Register and manage the agents you observe. Connect a repo from here when you want Eden to see your code.",
  },
  {
    id: "prompts",
    kind: "nav",
    targetId: "prompts",
    href: "/prompts",
    title: "Prompts",
    body: "Versioned prompt templates with history — edit, compare, and roll back without redeploying guesswork.",
  },
  {
    id: "traces",
    kind: "nav",
    targetId: "traces",
    href: "/traces",
    title: "Traces",
    body: "Every AI call in one explorer. Open a row to inspect spans, replay sessions, debug checkpoints, or query the corpus.",
  },
  {
    id: "issues",
    kind: "nav",
    targetId: "issues",
    href: "/issues",
    title: "Issues",
    body: "Grouped agent failures and incident clusters — triage, heal, and verify instead of chasing one-off errors.",
  },
  {
    id: "alerts",
    kind: "nav",
    targetId: "alerts",
    href: "/alerts",
    title: "Alerts",
    body: "Threshold notifications and custom signal rules so you hear about cost, latency, or quality before customers do.",
  },
  {
    id: "analytics",
    kind: "nav",
    targetId: "analytics",
    href: "/analytics",
    title: "Analytics",
    body: "Usage, tools, users, and trend insights across agents — the long view of how the fleet behaves.",
  },
  {
    id: "evals",
    kind: "nav",
    targetId: "evals",
    href: "/evals",
    title: "Evals",
    body: "Datasets, labeling, custom metrics, and synthetic data — the ground truth loop that scores quality.",
  },
  {
    id: "improve",
    kind: "nav",
    targetId: "improve",
    href: "/improve",
    title: "Improve",
    body: "The action queue: patches, plans, and sweep history. Approve changes that close the loop from issue → fix.",
  },
  {
    id: "optimization",
    kind: "nav",
    targetId: "optimization",
    href: "/optimization",
    title: "Cost",
    body: "Where tokens go — budgets, outcomes, forecasts, and model-routing advice to spend less without losing quality.",
  },
  {
    id: "guardrails",
    kind: "nav",
    targetId: "guardrails",
    href: "/guardrails",
    title: "Guardrails",
    body: "Safety policies and red-team checks that block unsafe prompts, PII leaks, and policy violations.",
  },
  {
    id: "settings",
    kind: "nav",
    targetId: "settings",
    href: "/settings",
    title: "Settings",
    body: "Workspace controls — members, billing, gateway, retention, and PII.",
  },
  {
    id: "api-keys",
    kind: "nav",
    targetId: "api-keys",
    href: "/settings?tab=api-keys",
    title: "API keys",
    body: "Create an org API key here — you'll need it (and your org id) to send traces from the SDK. Keys are shown once at creation.",
  },
  {
    id: "finish",
    kind: "finish",
    href: "/settings?tab=api-keys",
    title: "Grab a key, then follow the quickstart",
    body: "Create an API key on this page, copy your org id, then install the SDK with the 5-minute quickstart. Eden is cloud-hosted — point the SDK at api.edenobservability.com.",
    ctaLabel: "Open quickstart docs",
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
    return PRODUCT_TOUR_TOTAL - 1; // finish / docs
  }
  if (s === "connect" || s === "connect_github") return 1; // start nav after welcome
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
