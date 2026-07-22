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
