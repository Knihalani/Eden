import { notFound } from "next/navigation";

/**
 * Catch-all 404 inside (portal).
 *
 * ui-audit 2026-07-06: Without this segment, an unknown URL inside
 * (portal) — e.g. /this-route-does-not-exist — is intercepted by
 * Clerk's auth.protect() in proxy.ts before it can reach the global
 * not-found.tsx, and the unauthenticated user is force-redirected to
 * /sign-in. That's a real UX bug: a typo shouldn't look like an
 * account problem.
 *
 * This optional catch-all slug segment matches any path that doesn't
 * resolve to a real route. It calls notFound(), which renders the
 * nearest not-found.tsx (the global one at src/app/not-found.tsx)
 * without requiring auth.
 *
 * The double brackets `[[...slug]]` make the segment optional, so it
 * also matches the bare (portal) path. That ensures the catch-all is
 * tried for *every* URL inside (portal) before the (portal) layout
 * has to decide what to render — meaning even routes that exist
 * still work normally; this only fires for routes that don't.
 */
export default function CatchAllNotFound() {
  notFound();
}
