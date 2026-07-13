// ponytail: the single source of truth for "which paths live inside (portal)".
// Used by both proxy.ts (server-side middleware: know which routes to gate)
// and (portal)/layout.tsx (client-side: know when to skip the loading skeleton
// for unknown URLs so the catch-all's notFound() can render immediately).

export const KNOWN_PORTAL_PREFIXES: readonly string[] = [
  "/dashboard",
  "/agents",
  "/datasets",
  "/labeling",
  "/traces",
  "/replay",
  "/observability",
  "/fleet",
  "/tools",
  "/insights",
  "/inspector",
  "/incidents",
  "/alerts",
  "/llmops",
  "/analytics",
  "/optimization",
  "/studio",
  "/guardrails",
  "/autonomous",
  "/improve",
  "/issues",
  "/closed-loop",
  "/pr-suggestions",
  "/settings",
  "/users",
  "/billing",
  "/profile",
  "/prompts",
  "/debugger",
  "/synthetic",
  "/runs",
  "/redteam",
  "/onboarding",
  "/signals",
] as const;

/** True when ``pathname`` matches a portal segment. Mirrors the denylist
 *  used by ``src/proxy.ts`` so the (portal) layout can render children
 *  immediately for unknown URLs (letting the catch-all's notFound() fire). */
export function isKnownPortalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0].split("#")[0];
  return KNOWN_PORTAL_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/")
  );
}
