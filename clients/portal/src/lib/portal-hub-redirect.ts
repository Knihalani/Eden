/**
 * Hub redirects after lab→product cutover.
 *
 * Live product paths pass through. Stale /lab/* URLs rewrite to canonical
 * routes. Remaining legacy stubs soft-land on /unavailable (not /rebuild).
 */

export interface HubRedirectRule {
  destination: string;
  tab?: string;
  defaultParams?: Record<string, string>;
}

export const HUB_REDIRECT_RULES: Record<string, HubRedirectRule> = {};

/** Soft-land for removed product URLs. */
export const STUB_LAND = "/unavailable";

/** Product leaves that are live (no hub bounce). */
export const LIVE_PRODUCT_PREFIXES = [
  "/home",
  "/agents",
  "/traces",
  "/sessions",
  "/issues",
  "/alerts",
  "/signals",
  "/evals",
  "/improve",
  "/cost",
  "/agent",
  "/debugger",
  "/compare",
  "/settings",
  "/prompts",
  "/guardrails",
  "/shell",
  "/rebuild",
  "/unavailable",
] as const;

/** Still-stub / removed surfaces → /unavailable. */
const STUB_PREFIXES = [
  "/marketplace",
  "/multi-agent",
  "/builder",
  "/jobs",
  "/eval-harnesses",
  "/sandbox",
  "/redteam",
  "/observability",
  "/inspector",
  "/analytics",
  "/users",
  "/tools",
  "/insights",
  "/fleet",
  "/incidents",
  "/ledger",
  "/promotions",
  "/artifacts",
  "/optimization",
  "/runs",
  "/datasets",
  "/playgrounds",
  "/experiments",
  "/labeling",
  "/studio",
  "/synthetic",
  "/docs-fill",
  "/autonomous",
  "/closed-loop",
  "/apm",
  "/profile",
  "/billing",
  "/finops",
  "/audit-trail",
  "/debugger-sessions",
  "/replay",
  "/_stub",
  "/audit",
] as const;

function isLiveProductPath(pathname: string): boolean {
  return LIVE_PRODUCT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function withSearch(path: string, search: string): string {
  if (!search) return path;
  return `${path}${search.startsWith("?") ? search : `?${search}`}`;
}

/**
 * Map /lab/foo → /foo (preserve query via caller).
 * /lab and /lab/ → /home.
 */
export function labToProductPath(pathname: string): string | null {
  if (pathname === "/lab" || pathname === "/lab/") return "/home";
  if (!pathname.startsWith("/lab/")) return null;
  const rest = pathname.slice("/lab".length);
  if (rest === "/" || rest === "") return "/home";
  return rest;
}

export function buildHubRedirectUrl(
  pathname: string,
  search: string,
): string | null {
  const p = pathname.split("?")[0].split("#")[0];

  const fromLab = labToProductPath(p);
  if (fromLab) return withSearch(fromLab, search);

  if (p === "/dashboard" || p.startsWith("/dashboard/")) {
    return withSearch("/home", search);
  }

  // First-run entry — product home with tour flag (tour UI ships in G15d).
  if (p === "/onboarding" || p.startsWith("/onboarding/")) {
    return "/home?tour=1";
  }

  if (p === "/rebuild" || p.startsWith("/rebuild/")) return null;
  if (p === "/unavailable" || p.startsWith("/unavailable/")) return null;
  if (isLiveProductPath(p)) return null;

  for (const prefix of STUB_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      return STUB_LAND;
    }
  }

  const exact = HUB_REDIRECT_RULES[p];
  if (exact) return exact.destination;
  return null;
}
