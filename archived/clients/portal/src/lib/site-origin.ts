/**
 * Canonical public site origin for SEO surfaces (sitemap, robots, metadata).
 *
 * Never throws: invalid / empty env values fall through to SITE_URL so
 * metadata routes cannot 500 on `new URL(...)` or string-concat of garbage.
 */

import { SITE_URL } from "@/lib/constants";

/** Env keys checked in order for the public marketing origin. */
const ORIGIN_ENV_KEYS = [
  "NEXT_PUBLIC_PORTAL_URL",
  "NEXT_PUBLIC_SITE_URL",
] as const;

function tryOrigin(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // `.origin` drops path / trailing slash so `/sitemap.xml` locs stay stable.
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the public site origin from env, falling back to SITE_URL.
 * Pass `env` in tests to inject bad values without mutating process.env.
 */
export function getSiteOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of ORIGIN_ENV_KEYS) {
    const origin = tryOrigin(env[key]);
    if (origin) return origin;
  }
  return tryOrigin(SITE_URL) ?? "https://edenobservability.com";
}

/** Absolute URL for a marketing path (`/` → origin with no trailing slash). */
export function absoluteSiteUrl(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origin = getSiteOrigin(env);
  if (!path || path === "/") return origin;
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}
