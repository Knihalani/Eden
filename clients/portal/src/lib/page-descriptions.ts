/**
 * Single source of truth for "what is this page for" copy.
 *
 * Used by PageHeader to render a hover-info icon next to the page
 * title. With ~30 portal pages, a tooltip per page is the fastest
 * way for a new user to learn the IA without having to click into
 * every link in the sidebar.
 *
 * Keep the voice consistent across pages: second-person ("You"),
 * 1-2 sentences, outcome-oriented ("See X, do Y") rather than
 * feature-oriented ("This page contains X").
 */

export const PAGE_DESCRIPTIONS: Record<string, string> = {
  // Build
  "/dashboard":
    "One-glance view of agents, traces, costs, and alerts for the active org. Start here.",
  "/agents":
    "Every AI agent connected to this org. Connect a repo, edit prompts, view runs.",
  "/agents/connect":
    "Link a GitHub repository so Eden can read your code and open integration PRs.",
  "/datasets":
    "Curated, labelled evaluation datasets used to score and improve agents.",
  "/labeling":
    "Label traces and events to build ground truth for evals and fine-tunes.",
  "/builder":
    "Visually design agent workflows, tool calls, and routing logic.",
  "/marketplace":
    "Browse and install pre-built agents, tools, and integrations from the catalog.",
  "/multi-agent":
    "Orchestrate multiple agents that collaborate on a shared task. Beta.",

  // Observe
  "/traces":
    "Every AI call your agents made — inputs, outputs, latency, and cost, in one table.",
  "/replay":
    "Step through a recorded session to see exactly what the agent saw and did.",
  "/observability":
    "Deep observability hub: APM, memory, retrieval, eval, and columnar query surfaces.",
  "/observability/apm":
    "Application-performance tracing across services and AI calls.",
  "/observability/cohorts":
    "Run fast columnar analytics over spans, traces, and decisions.",
  "/observability/decisions":
    "Inspect what an agent decided and why, with policy and prompt context.",
  "/observability/eval":
    "Score traces against evals to measure quality and regressions.",
  "/observability/memory":
    "Inspect the memory store an agent reads from and writes to.",
  "/observability/query":
    "Ad-hoc query the trace corpus with natural language or SQL.",
  "/observability/retrieval":
    "Debug retrieval-augmented generation: chunks, scores, and grounding.",
  "/observability/time-travel":
    "Reconstruct the state of an agent at any point in a past run.",
  "/tools":
    "See which tools your agents call most, compare success rates, and get recommendations.",
  "/insights":
    "AI-generated summaries of trends, anomalies, and what to look at next.",
  "/inspector":
    "Deep-dive into a single trace to debug behaviour, token usage, and tool I/O.",
  "/incidents":
    "Clustered failures and anomalies grouped by root cause.",
  "/alerts":
    "Configure notifications when traces, costs, or quality cross a threshold.",
  "/llmops":
    "Operational controls for LLM providers, rate limits, and fallbacks.",
  "/analytics":
    "Cross-cutting analytics: usage, cost, latency, and quality over time.",

  // Optimize
  "/optimization":
    "Cost surfaces — see spend, predict the bill, and get model-change advice.",
  "/optimization/outcomes":
    "Business-outcome attribution from agent runs to downstream results.",
  "/optimization/predict":
    "Forecast upcoming cost and usage based on current trajectory.",
  "/optimization/model-advisor":
    "Get model-routing suggestions to cut cost without hurting quality.",
  "/studio":
    "Define custom metrics and dimensions for traces and runs.",
  "/guardrails":
    "Block unsafe prompts, PII leaks, and policy violations before they ship.",

  // Automate
  "/autonomous":
    "Let Eden autonomously investigate, patch, and propose fixes to your codebase.",
  "/closed-loop":
    "Closed-loop improvements — events flow from detection back to deploy.",
  "/pr-suggestions":
    "Auto-generated PRs that fix issues Eden finds in your repo.",

  // Workspace
  "/settings":
    "Workspace, integrations, sidebar, and notification settings.",
  "/users":
    "Invite teammates and manage org members and roles.",
  "/billing":
    "Plan, invoices, payment method, and usage-based charges.",
  "/profile":
    "Your personal account settings, sessions, and API keys.",

  // Other
  "/runs":
    "Live and recent runs of agents, jobs, and evaluations.",
  "/prompts":
    "Manage the prompt templates your agents use.",
  "/debugger":
    "Step-by-step debugger for agent execution traces.",
  "/synthetic":
    "Generate synthetic evaluation data for testing and fine-tuning.",
  "/redteam":
    "Run adversarial test suites against your agents.",
  "/signals":
    "Custom signals you can wire into alerts and dashboards.",
  "/onboarding":
    "Get the most out of Eden — finish setup, connect your stack, invite teammates.",
};

/** Look up the description for a pathname; returns undefined if none. */
export function getPageDescription(pathname: string): string | undefined {
  // Strip query string and hash before lookup so /tools?tab=foo
  // matches /tools. The sidebar items are referenced by path only.
  const path = pathname.split("?")[0].split("#")[0];
  return PAGE_DESCRIPTIONS[path];
}
