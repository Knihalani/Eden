// Single source of truth for portal breadcrumb labels.
// ponytail: extract this from (portal)/layout.tsx so future label
// changes don't require hunting through a 700-line layout file.
// The `category` field lets the layout prefix the breadcrumb with
// the sidebar group (e.g. "Observe · APM Tracing") without
// re-implementing the sidebar-group lookup in two places.

export type SidebarGroupId =
  | "build"
  | "observe"
  | "optimize"
  | "automate"
  | "admin";

export interface BreadcrumbLabel {
  label: string;
  /** Sidebar group the segment belongs to (used for the
   *  "Observe · APM Tracing" prefix in the top-bar breadcrumb). */
  category?: SidebarGroupId;
}

export const BREADCRUMB_LABELS: Record<string, BreadcrumbLabel> = {
  dashboard: { label: "Dashboard", category: "build" },
  analytics: { label: "Analytics", category: "observe" },
  optimization: { label: "Cost", category: "optimize" },
  settings: { label: "Settings", category: "admin" },
  billing: { label: "Billing", category: "admin" },
  docs: { label: "Documentation", category: "admin" },
  profile: { label: "Profile", category: "admin" },
  new: { label: "New", category: "build" },
  observability: { label: "Observability", category: "observe" },
  incidents: { label: "Incidents", category: "observe" },
  insights: { label: "Insights", category: "observe" },
  inspector: { label: "Inspector", category: "observe" },
  alerts: { label: "Alerts", category: "observe" },
  llmops: { label: "LLMOps", category: "observe" },
  agents: { label: "Agents", category: "build" },
  builder: { label: "Builder", category: "build" },
  marketplace: { label: "Marketplace", category: "build" },
  "multi-agent": { label: "Multi-Agent", category: "build" },
  sandbox: { label: "Sandbox", category: "build" },
  users: { label: "Members", category: "admin" },
  guardrails: { label: "Guardrails", category: "optimize" },
  autonomous: { label: "Autonomous", category: "automate" },
  studio: { label: "Custom Metrics", category: "optimize" },
  "pr-suggestions": { label: "PR Suggestions", category: "automate" },
  retrieval: { label: "Retrieval", category: "observe" },
  memory: { label: "Memory", category: "observe" },
  "time-travel": { label: "Time-Travel", category: "observe" },
  apm: { label: "APM Tracing", category: "observe" },
  decisions: { label: "Decisions", category: "observe" },
  outcomes: { label: "Outcomes", category: "optimize" },
  predict: { label: "Predictive", category: "optimize" },
  tools: { label: "Tools", category: "observe" },
  query: { label: "Query", category: "observe" },
  cohorts: { label: "Columnar Engine", category: "observe" },
  governance: { label: "Governance", category: "observe" },
  eval: { label: "Eval", category: "observe" },
  traces: { label: "Trace Explorer", category: "observe" },
  onboarding: { label: "Onboarding", category: "admin" },
  connect: { label: "Connect Agent", category: "build" },
};

export interface Breadcrumb {
  label: string;
  href: string;
  category?: SidebarGroupId;
}

export function buildBreadcrumbs(pathname: string): Breadcrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [];
  let path = "";
  for (const segment of segments) {
    path += `/${segment}`;
    const entry = BREADCRUMB_LABELS[segment];
    const label = entry?.label ?? segment.charAt(0).toUpperCase() + segment.slice(1);
    crumbs.push({ label, href: path, category: entry?.category });
  }
  return crumbs;
}