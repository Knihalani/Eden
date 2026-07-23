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
  "/docs-fill",
  "/runs",
  "/datasets",
  "/playgrounds",
  "/experiments",
  "/labeling",
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
] as const;

/** @deprecated Use STUB_PORTAL_PATH_PREFIXES — kept for older imports. */
export const REMOVED_PORTAL_PATH_PREFIXES = STUB_PORTAL_PATH_PREFIXES;

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
  "/unavailable",
  "/onboarding", // redirects to /home?tour=1
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
