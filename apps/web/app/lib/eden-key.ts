/**
 * Credential resolution for the web plane.
 *
 * Every org of a deployment used to share the literal "eden_dev" fallback, so
 * the Clerk gate authenticated who but never bound which workspace. The
 * fallback now exists only where the embedded control plane itself would still
 * honour it — mirroring the managed-install checks in @eden/control and
 * apps/site (DATABASE_URL / VERCEL mean managed; EDEN_DEV overrides). On a
 * managed install a missing EDEN_API_KEY is an error, never a known public
 * credential.
 */
export function isManagedDeployment(): boolean {
  return Boolean(process.env.DATABASE_URL) || Boolean(process.env.VERCEL);
}

function devFallbackAllowed(): boolean {
  return isManagedDeployment() ? process.env.EDEN_DEV === "1" : process.env.EDEN_DEV !== "0";
}

/**
 * The bearer token for the embedded control plane. Throws on a managed
 * install with no EDEN_API_KEY rather than silently presenting eden_dev.
 */
export function edenKey(): string {
  const key = process.env.EDEN_API_KEY;
  if (key) return key;
  if (devFallbackAllowed()) return "eden_dev";
  throw new Error("EDEN_API_KEY is not set");
}
