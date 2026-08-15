/**
 * Soft-land suggestions for removed / stub product URLs.
 *
 * Keys are DEAD routes only — if a path ships as a live page it must be
 * removed from this map (src/lib/nav-registry-parity.test.ts enforces it).
 * Every destination must point at a live surface.
 */
export const STUB_TRY_INSTEAD: Record<string, { href: string; label: string }> = {
  "/billing": { href: "/settings?mode=workspace", label: "Settings" },
  "/finops": { href: "/cost?mode=spend", label: "Cost" },
  "/observability": { href: "/traces", label: "Traces" },
  "/debugger-sessions": { href: "/debugger", label: "Debugger" },
  "/audit": { href: "/settings?mode=audit", label: "Settings · Audit" },
  "/audit-trail": { href: "/settings?mode=audit", label: "Settings · Audit" },
  "/analytics": { href: "/gateway", label: "Gateway" },
  "/studio": { href: "/playgrounds", label: "Playgrounds" },
  "/synthetic": { href: "/evals?mode=compare", label: "Evals · Results" },
  "/datasets": { href: "/evals?mode=datasets", label: "Evals · Datasets" },
  "/experiments": { href: "/evals?mode=compare", label: "Evals · Results" },
  "/promotions": { href: "/improve?mode=queue", label: "Improve · Queue" },
  "/optimization": { href: "/cost?mode=spend", label: "Cost" },
  "/runs": { href: "/traces", label: "Traces" },
  "/fleet": { href: "/agents", label: "Agents" },
  "/incidents": { href: "/issues", label: "Issues" },
  "/profile": { href: "/settings", label: "Settings" },
  "/insights": { href: "/home", label: "Home" },
};

/** Longest-prefix match of a dead URL against the map; null when live/unknown. */
export function stubPrefix(pathname: string): string | null {
  const p = pathname.split("?")[0].split("#")[0];
  if (p === "/unavailable" || p.startsWith("/unavailable/")) return null;
  const keys = Object.keys(STUB_TRY_INSTEAD).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (p === key || p.startsWith(`${key}/`)) return key;
  }
  return null;
}
