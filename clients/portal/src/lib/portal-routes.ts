/**
 * Authenticated product prefixes after lab→product cutover.
 */

/** Still-stub surfaces — middleware may redirect these to /rebuild. */
export const STUB_PORTAL_PATH_PREFIXES: readonly string[] = [
  "/marketplace",
  "/multi-agent",
  "/builder",
  "/jobs",
  "/eval-harnesses",
  "/sandbox",
  "/observability",
  "/inspector",
  "/analytics",
  "/users",
  "/tools",
  "/insights",
  "/fleet",
  "/incidents",
  "/promotions",
  "/optimization",
  "/runs",
  "/datasets",
  "/experiments",
  "/studio",
  "/synthetic",
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
  "/shell",
] as const;

export function isRemovedPortalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0].split("#")[0];
  return STUB_PORTAL_PATH_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/"),
  );
}

/** Live product leaves (auth.protect). */
export const LIVE_PORTAL_PREFIXES: readonly string[] = [
  "/rebuild",
  "/lab", // stale URLs — still protected while redirecting
  "/home",
  "/dashboard", // redirects to /home
  "/agents",
  "/traces",
  "/sessions",
  "/issues",
  "/alerts",
  "/signals",
  "/topics",
  "/drift",
  "/evals",
  "/playgrounds",
  "/improve",
  "/cost",
  "/gateway",
  "/agent",
  "/debugger",
  "/compare",
  "/settings",
  "/prompts",
  "/guardrails",
  "/labeling",
  "/artifacts",
  "/ledger",
  "/unavailable",
  "/onboarding", // redirects to /home (no forced tour)
] as const;

/** Authenticated product prefixes (auth.protect targets). */
export const KNOWN_PORTAL_PREFIXES: readonly string[] = [
  ...LIVE_PORTAL_PREFIXES,
  ...STUB_PORTAL_PATH_PREFIXES,
] as const;

export function isKnownPortalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0].split("#")[0];
  return KNOWN_PORTAL_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/"),
  );
}
