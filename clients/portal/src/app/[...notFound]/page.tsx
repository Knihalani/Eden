import { notFound } from "next/navigation";

/**
 * Global catch-all 404.
 *
 * ui-audit 2026-07-09: Without this segment, an unknown URL at the
 * root level (e.g. /this-route-does-not-exist) is intercepted by
 * Clerk's auth.protect() in proxy.ts before it can reach the
 * global not-found.tsx, and the unauthenticated user is
 * force-redirected to /sign-in. That's a real UX bug: a typo
 * shouldn't look like an account problem.
 *
 * This required catch-all slug segment matches any path that
 * doesn't resolve to a real route under (marketing) / (portal) /
 * (auth). It calls notFound(), which renders the global
 * not-found.tsx without requiring auth.
 */
export default function GlobalCatchAllNotFound() {
  notFound();
}
