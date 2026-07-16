/**
 * Single source of truth for "what is this page for" copy.
 */

export const PAGE_DESCRIPTIONS: Record<string, string> = {
  "/dashboard":
    "One-glance view of agents, traces, costs, and alerts for the active org. Start here.",
  "/agents":
    "Every AI agent connected to this org. Connect a repo, edit prompts, view fleet health.",
  "/agents/connect":
    "Install the Eden GitHub App and link a repository. SDK install is manual.",
  "/traces":
    "Every AI call — explore, inspect, replay, and debug from one place.",
  "/issues":
    "Grouped agent failures and systemic incident clusters.",
  "/alerts":
    "Threshold notifications and custom signal rules.",
  "/analytics":
    "Usage, tools, users, and trend insights.",
  "/evals":
    "Datasets, labeling, studio metrics, synthetic data, and eval scores.",
  "/improve":
    "Action queue, improvement plans, and sweep history.",
  "/optimization":
    "Spend, budgets, outcomes, forecasts, and model advice.",
  "/guardrails":
    "Safety policies and red-team tests.",
  "/prompts":
    "Version and manage prompt templates.",
  "/settings":
    "Members, billing, account, gateway, retention, PII, and exports.",
  "/runs":
    "Live and recent runs of agents, jobs, and evaluations.",
};

export function getPageDescription(pathname: string): string | undefined {
  const path = pathname.split("?")[0].split("#")[0];
  if (PAGE_DESCRIPTIONS[path]) return PAGE_DESCRIPTIONS[path];
  const segments = path.split("/").filter(Boolean);
  while (segments.length > 1) {
    segments.pop();
    const candidate = "/" + segments.join("/");
    if (PAGE_DESCRIPTIONS[candidate]) return PAGE_DESCRIPTIONS[candidate];
  }
  return undefined;
}
