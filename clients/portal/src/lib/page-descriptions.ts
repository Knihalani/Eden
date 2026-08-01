/**
 * Single source of truth for "what is this page for" copy.
 */

export const PAGE_DESCRIPTIONS: Record<string, string> = {
  "/home":
    "One-glance view of agents, traces, costs, and detectors for the active org. Start here.",
  "/dashboard":
    "One-glance view of agents, traces, costs, and detectors for the active org. Start here.",
  "/agents":
    "Every AI agent seen in this org. Agents appear from SDK agent_id on ingest. Connect a repo from an agent’s detail view when you want Improve to open fix PRs.",
  "/agents/connect":
    "Link the GitHub repo that holds a selected agent’s code. Eden opens Improve fix PRs on that repo.",
  "/gateway":
    "Gateway spend, tokens, models, providers, and cache hit rates for this workspace.",
  "/traces":
    "Every AI call — explore, inspect, replay, and debug from one place.",
  "/issues":
    "Grouped agent failures and systemic incident clusters.",
  "/alerts":
    "Soft-lands on Detectors — threshold notifications and custom signal rules.",
  "/signals":
    "Detectors: threshold notifications and custom signal rules.",
  "/analytics":
    "Usage, tools, users, and trend insights.",
  "/evals":
    "Datasets, playground, and offline experiment results — Observe → Evaluate loop.",
  "/compare":
    "Live A/B — run prompt or model variants against production traffic and read the verdict.",
  "/improve":
    "Review queue and improvement plans — approve, reject, and open evidence-linked fixes.",
  "/artifacts":
    "Soft-lands on Improve queue — versioned runtime fixes with evidence-gated promotion.",
  "/ledger":
    "Soft-lands on Improve queue — institutional memory and promotion history.",
  "/prompts":
    "Version and manage prompt templates — iterate via Evaluate playground.",
  "/optimization":
    "Soft-lands on Cost — spend and drivers for this workspace.",
  "/guardrails":
    "Safety policies and red-team tests — Advanced Improve.",
  "/improve/scorecard":
    "Synthetic process-gate microbench — Advanced Improve only.",
  "/improve/online-scoring":
    "Production scorers on sampled traces — Advanced Improve.",
  "/improve/change-impact":
    "Replay traffic before shipping prompt or model changes — Advanced Improve.",
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
