/**
 * Hub redirects after lab→product cutover.
 *
 * Live product paths pass through. Stale /lab/* URLs rewrite to canonical
 * routes. Remaining legacy stubs soft-land on /unavailable (not /rebuild).
 *
 * The live/stub prefix lists are the single source of truth in
 * portal-routes.ts (the auth-gate file) — imported here rather than
 * hand-duplicated, so this module's redirect logic and the auth gate
 * can never silently drift apart again.
 */

import {
  LIVE_PORTAL_PREFIXES,
  STUB_PORTAL_PATH_PREFIXES,
} from "@/lib/portal-routes";

export interface HubRedirectRule {
  destination: string;
  tab?: string;
  defaultParams?: Record<string, string>;
}

export const HUB_REDIRECT_RULES: Record<string, HubRedirectRule> = {};

/** Soft-land for removed product URLs. */
export const STUB_LAND = "/unavailable";

/** Product leaves that are live (no hub bounce). Re-exported for older imports. */
export const LIVE_PRODUCT_PREFIXES = LIVE_PORTAL_PREFIXES;

/** Still-stub / removed surfaces → /unavailable. Re-exported for older imports. */
export const STUB_PREFIXES = STUB_PORTAL_PATH_PREFIXES;

function isLiveProductPath(pathname: string): boolean {
  return LIVE_PORTAL_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function withSearch(path: string, search: string): string {
  if (!search) return path;
  return `${path}${search.startsWith("?") ? search : `?${search}`}`;
}

/**
 * Map /lab/foo → /foo (preserve query via caller).
 * /lab and /lab/ → /home.
 */
export function labToProductPath(pathname: string): string | null {
  if (pathname === "/lab" || pathname === "/lab/") return "/home";
  if (!pathname.startsWith("/lab/")) return null;
  const rest = pathname.slice("/lab".length);
  if (rest === "/" || rest === "") return "/home";
  return rest;
}

export function buildHubRedirectUrl(
  pathname: string,
  search: string,
): string | null {
  const p = pathname.split("?")[0].split("#")[0];

  const fromLab = labToProductPath(p);
  if (fromLab) return withSearch(fromLab, search);

  if (p === "/dashboard" || p.startsWith("/dashboard/")) {
    return withSearch("/home", search);
  }

  // First-run entry — product home with soft-open tour. Merge the
  // incoming query with the hardcoded onboarding=1 param rather than
  // naively concatenating (the base path already has a `?`, so a plain
  // withSearch() call here would produce a second `?` and corrupt the
  // URL — see portal-hub-redirect.test history for the bug this fixes).
  if (p === "/onboarding" || p.startsWith("/onboarding/")) {
    const extra = search.replace(/^\?/, "");
    return extra ? `/home?onboarding=1&${extra}` : "/home?onboarding=1";
  }

  if (p === "/rebuild" || p.startsWith("/rebuild/")) return null;
  if (p === "/unavailable" || p.startsWith("/unavailable/")) return null;
  if (isLiveProductPath(p)) return null;

  for (const prefix of STUB_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      return STUB_LAND;
    }
  }

  const exact = HUB_REDIRECT_RULES[p];
  if (exact) return exact.destination;
  return null;
}
