/**
 * Portal path prefixes during rebuild.
 * Later surfaces (Analytics/Prompts) still soft-land → /dashboard.
 */

export const REMOVED_PORTAL_PATH_PREFIXES: readonly string[] = [
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
  "/signals",
  "/prompts",
  "/ledger",
  "/promotions",
  "/artifacts",
  "/optimization",
  "/onboarding",
  "/docs-fill",
  "/runs",
] as const;

export function isRemovedPortalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0].split("#")[0];
  return REMOVED_PORTAL_PATH_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/"),
  );
}

/** Authenticated product prefixes (auth.protect targets). */
export const KNOWN_PORTAL_PREFIXES: readonly string[] = [
  "/dashboard",
  "/_stub",
  "/agents",
  "/traces",
  "/sessions",
  "/issues",
  "/alerts",
  "/evals",
  "/improve",
  "/guardrails",
  "/cost",
  "/agent",
  "/audit",
  "/settings",
  "/debugger",
  "/profile",
  "/billing",
  "/finops",
  "/audit-trail",
  "/debugger-sessions",
  "/replay",
  // Soft-land ghosts (redirect → /dashboard)
  ...REMOVED_PORTAL_PATH_PREFIXES,
] as const;

export function isKnownPortalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0].split("#")[0];
  return KNOWN_PORTAL_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/"),
  );
}
