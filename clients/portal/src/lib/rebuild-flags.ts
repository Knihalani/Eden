/**
 * Portal rebuild feature flags.
 * NEXT_PUBLIC_PORTAL_REBUILD_STUB documents stub/coming-soon mode for clients.
 */

export function isPortalRebuildStub(): boolean {
  return (
    process.env.NEXT_PUBLIC_PORTAL_REBUILD_STUB === "1" ||
    process.env.PORTAL_REBUILD_STUB === "1"
  );
}

/**
 * Internal-only surfaces (/rebuild review board, /shell surface index).
 * Set NEXT_PUBLIC_EDEN_INTERNAL=1 (or EDEN_INTERNAL=1 server-side) on
 * internal deployments; everyone else soft-lands on /unavailable.
 */
export function isEdenInternal(): boolean {
  return (
    process.env.NEXT_PUBLIC_EDEN_INTERNAL === "1" ||
    process.env.EDEN_INTERNAL === "1"
  );
}
