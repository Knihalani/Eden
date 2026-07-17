/**
 * Query-preserving hub consolidations for legacy list URLs.
 * Next.js static redirects drop source query when the destination already has `?`.
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
  "/fleet": { destination: "/agents", tab: "fleet" },
  "/incidents": { destination: "/issues", tab: "incidents" },
  "/users": { destination: "/analytics", tab: "users" },
  "/insights": { destination: "/analytics", tab: "insights" },
  "/tools": { destination: "/analytics", tab: "tools" },
  "/autonomous": { destination: "/improve" },
  "/closed-loop": { destination: "/improve" },
  "/apm": { destination: "/traces" },
  "/replay": { destination: "/traces", defaultParams: { view: "replay" } },
  "/debugger": { destination: "/traces", defaultParams: { view: "debug" } },
  "/observability": { destination: "/traces" },
  "/redteam": { destination: "/guardrails", tab: "redteam" },
  "/profile": { destination: "/settings", tab: "account" },
  "/billing": { destination: "/settings", tab: "billing" },
};

export function buildHubRedirectUrl(pathname: string, search: string): string | null {
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
