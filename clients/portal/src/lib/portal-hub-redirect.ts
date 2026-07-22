/**
 * Query-preserving hub consolidations for legacy list URLs.
 * Used by `proxy.ts` middleware (before page render).
 * Keep in lockstep with `next.config.ts` redirects + IA kill-list.
 */

export interface HubRedirectRule {
  destination: string;
  /** Applied only when the incoming request has no `tab` param. */
  tab?: string;
  defaultParams?: Record<string, string>;
}

/** Exact-path list consolidations — nested detail routes are excluded by exact match. */
export const HUB_REDIRECT_RULES: Record<string, HubRedirectRule> = {
  "/datasets": { destination: "/evals", tab: "datasets" },
  "/playgrounds": { destination: "/evals", tab: "playgrounds" },
  "/experiments": { destination: "/evals", tab: "experiments" },
  "/labeling": { destination: "/evals", tab: "labeling" },
  "/studio": { destination: "/evals", tab: "studio" },
  "/synthetic": { destination: "/evals", tab: "synthetic" },
  "/signals": { destination: "/alerts", tab: "signals" },
  "/promotions": { destination: "/improve", tab: "promotions" },
  "/ledger": { destination: "/improve", tab: "ledger" },
  "/artifacts": { destination: "/improve", tab: "artifacts" },
  "/fleet": { destination: "/agents", tab: "fleet" },
  "/incidents": { destination: "/issues", tab: "incidents" },
  "/users": { destination: "/analytics", tab: "users" },
  "/insights": { destination: "/analytics", tab: "insights" },
  "/tools": { destination: "/analytics", tab: "tools" },
  "/autonomous": { destination: "/improve" },
  "/closed-loop": { destination: "/improve" },
  "/apm": { destination: "/traces" },
  "/replay": { destination: "/debugger", defaultParams: { tab: "replay" } },
  "/inspector": { destination: "/traces", defaultParams: { mode: "meta" } },
  "/observability": { destination: "/traces" },
  // Query-preserving soft nests (next.config drops source query when dest has `?`).
  "/observability/mcp": {
    destination: "/traces",
    defaultParams: { facet: "mcp" },
  },
  "/observability/decisions": {
    destination: "/traces",
    defaultParams: { facet: "decisions" },
  },
  "/observability/memory": {
    destination: "/traces",
    defaultParams: { facet: "memory" },
  },
  "/observability/retrieval": {
    destination: "/traces",
    defaultParams: { facet: "retrieval" },
  },
  "/observability/time-travel": {
    destination: "/debugger",
    defaultParams: { tab: "time-travel" },
  },
  "/observability/cohorts": { destination: "/traces" },
  "/observability/query": { destination: "/traces" },
  "/observability/eval": { destination: "/evals", tab: "eval" },
  "/redteam": { destination: "/guardrails", tab: "policies" },
  "/profile": { destination: "/settings", tab: "account" },
  "/billing": { destination: "/settings", tab: "billing" },
  "/finops": { destination: "/settings", tab: "finops" },
  "/audit-trail": { destination: "/audit" },
  "/optimization": { destination: "/cost" },
  "/optimization/predict": { destination: "/cost", tab: "forecast" },
  "/optimization/model-advisor": { destination: "/cost", tab: "advisor" },
  "/optimization/budget": { destination: "/cost", tab: "budget" },
  "/optimization/outcomes": { destination: "/cost", tab: "outcomes" },
};

export function buildHubRedirectUrl(
  pathname: string,
  search: string,
): string | null {
  const rule = HUB_REDIRECT_RULES[pathname];
  if (!rule) return null;

  const raw = search.startsWith("?") ? search.slice(1) : search;
  const merged = new URLSearchParams(raw);

  if (rule.tab && !merged.has("tab")) {
    merged.set("tab", rule.tab);
  }
  if (rule.defaultParams) {
    for (const [key, value] of Object.entries(rule.defaultParams)) {
      if (!merged.has(key)) merged.set(key, value);
    }
  }

  const qs = merged.toString();
  return `${rule.destination}${qs ? `?${qs}` : ""}`;
}
