// Known portal path prefixes after July 2026 IA consolidation.
// Ghost routes redirect via next.config.ts and are intentionally omitted.

export const KNOWN_PORTAL_PREFIXES: readonly string[] = [
  "/dashboard",
  "/agents",
  "/traces",
  "/sessions",
  "/issues",
  "/alerts",
  "/artifacts",
  "/ledger",
  "/promotions",
  "/analytics",
  "/evals",
  "/improve",
  "/optimization",
  "/guardrails",
  "/prompts",
  "/settings",
  "/runs",
  // Deep-link / tab-source survivors (list URLs redirect via next.config)
  "/incidents",
  "/datasets",
  "/playgrounds",
  "/experiments",
  "/labeling",
  "/studio",
  "/synthetic",
  "/observability",
  "/inspector",
  "/replay",
  "/debugger",
  "/debugger-sessions",
  "/fleet",
  "/audit-trail",
  "/insights",
  "/tools",
  "/users",
  "/signals",
  "/redteam",
  "/profile",
  "/docs-fill",
  "/onboarding",
] as const;

export function isKnownPortalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0].split("#")[0];
  return KNOWN_PORTAL_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/")
  );
}
