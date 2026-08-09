// Single source of truth for portal breadcrumb labels.
// ponytail: extract this from (portal)/layout.tsx so future label
// changes don't require hunting through a 700-line layout file.
// The `category` field lets the layout prefix the breadcrumb with
// the sidebar group (e.g. "Observe · APM Tracing") without
// re-implementing the sidebar-group lookup in two places.

export type SidebarGroupId =
  | "observe"
  | "improve"
  | "evaluate"
  | "assist"
  | "workspace";

export interface BreadcrumbLabel {
  label: string;
  /** Sidebar group the segment belongs to (used for the
   *  "Observe · APM Tracing" prefix in the top-bar breadcrumb). */
  category?: SidebarGroupId;
}

export const BREADCRUMB_LABELS: Record<string, BreadcrumbLabel> = {
  // Leaf matches sidebar + PageHeader ("Home"); omit category so crumb
  // is "Home" not redundant "Home · Home".
  dashboard: { label: "Home" },
  analytics: { label: "Analytics", category: "observe" },
  optimization: { label: "Cost", category: "improve" },
  budget: { label: "Budget", category: "improve" },
  settings: { label: "Settings", category: "workspace" },
  overview: { label: "Overview", category: "workspace" },
  billing: { label: "Billing", category: "workspace" },
  docs: { label: "Quickstart", category: "workspace" },
  profile: { label: "Profile", category: "workspace" },
  new: { label: "New", category: "observe" },
  observability: { label: "Observability", category: "observe" },
  incidents: { label: "Incidents", category: "observe" },
  insights: { label: "Insights", category: "observe" },
  inspector: { label: "Inspector", category: "observe" },
  alerts: { label: "Detectors", category: "observe" },
  llmops: { label: "LLMOps", category: "observe" },
  agents: { label: "Agents", category: "observe" },
  // sandbox / builder / marketplace / multi-agent removed — env-gen strip
  users: { label: "User Intelligence", category: "observe" },
  prompts: { label: "Prompts", category: "improve" },
  debugger: { label: "Debugger", category: "assist" },
  synthetic: { label: "Synthetic Q/A", category: "observe" },
  signals: { label: "Signals", category: "observe" },
  topics: { label: "Topics", category: "observe" },
  members: { label: "Members", category: "workspace" },
  guardrails: { label: "Guardrails", category: "improve" },
  autonomous: { label: "Autonomous", category: "evaluate" },
  improve: { label: "Improve", category: "improve" },
  // Align with sidebar IA ("Issues", not "Agent Issues").
  issues: { label: "Issues", category: "observe" },
  studio: { label: "Custom Metrics", category: "improve" },
  "pr-suggestions": { label: "PR Suggestions", category: "evaluate" },
  eden: { label: "Eden", category: "evaluate" },
  inbox: { label: "PR Inbox", category: "evaluate" },
  retrieval: { label: "Retrieval", category: "observe" },
  memory: { label: "Memory", category: "observe" },
  "time-travel": { label: "Time-Travel", category: "observe" },
  apm: { label: "Traces", category: "observe" },
  decisions: { label: "Decisions", category: "observe" },
  outcomes: { label: "Outcomes", category: "improve" },
  predict: { label: "Predictive", category: "improve" },
  forecast: { label: "Forecast", category: "improve" },
  tools: { label: "Tools", category: "observe" },
  query: { label: "Query", category: "observe" },
  cohorts: { label: "Columnar Engine", category: "observe" },
  governance: { label: "Governance", category: "observe" },
  eval: { label: "Eval", category: "observe" },
  traces: { label: "Traces", category: "observe" },
  onboarding: { label: "Onboarding", category: "workspace" },
  connect: { label: "Connect Agent", category: "observe" },
  fleet: { label: "Fleet", category: "observe" },
  replay: { label: "Replay", category: "observe" },
  datasets: { label: "Datasets", category: "evaluate" },
  labeling: { label: "Labeling", category: "evaluate" },
  mcp: { label: "MCP SRE", category: "observe" },
  "model-advisor": { label: "Model Advisor", category: "improve" },
  "closed-loop": { label: "Closed-Loop", category: "evaluate" },
  artifacts: { label: "Artifacts", category: "improve" },
  experiments: { label: "Experiments", category: "evaluate" },
  playgrounds: { label: "Playgrounds", category: "evaluate" },
  promotions: { label: "Promotions", category: "improve" },
  evals: { label: "Evals", category: "evaluate" },
  sessions: { label: "Sessions", category: "observe" },
  ledger: { label: "Ledger", category: "improve" },
  book: { label: "Agent Book", category: "evaluate" },
  drift: { label: "Drift", category: "evaluate" },
  "debugger-sessions": { label: "Debug sessions", category: "assist" },
  scorecard: { label: "Scorecard", category: "improve" },
  "online-scoring": { label: "Online scoring", category: "improve" },
  "change-impact": { label: "Change impact", category: "improve" },
  audit: { label: "Audit trail", category: "workspace" },
  "audit-trail": { label: "Audit trail", category: "workspace" },
  agent: { label: "Assistant", category: "assist" },
  compare: { label: "Live A/B", category: "evaluate" },
  gateway: { label: "Gateway", category: "improve" },
  cost: { label: "Cost", category: "improve" },
};

export interface Breadcrumb {
  label: string;
  href: string;
  category?: SidebarGroupId;
}

export function buildBreadcrumbs(pathname: string): Breadcrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [];
  let href = "";
  for (const segment of segments) {
    href += `/${segment}`;
    const meta = BREADCRUMB_LABELS[segment];
    crumbs.push({
      label: meta?.label ?? segment,
      href,
      category: meta?.category,
    });
  }
  return crumbs;
}
