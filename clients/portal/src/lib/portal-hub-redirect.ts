/**
 * Hub routing after the lab→product cutover.
 *
 * Live product paths pass through. Everything else is either a
 * *redirect* (the URL changes, the browser navigates) or a *rewrite*
 * (the URL stays, a different route renders) — `resolveHubTarget`
 * returns which. The split is deliberate, per mapping:
 *
 * - `/lab/*` → canonical leaf: **redirect**. `/lab` is a retired
 *   namespace, and the portal shell derives state from
 *   `usePathname()` — the sidebar's active item (`isNavActive`),
 *   `PortalCatalogSync`'s route-scoped prefetch, and `useQueryPatch`'s
 *   URL rebuilding all compare against `/traces`, `/home`, … A rewrite
 *   would leave `/lab/traces` in the address bar forever, so none of
 *   those would ever match. One 307 to the canonical URL is cheap and
 *   self-healing: the user's bookmark ends up correct.
 *   (The pre-July-2026 version of this docstring claimed "rewrite"
 *   here while the code always redirected. The code was right.)
 *
 * - `/dashboard*` → `/home`: **redirect**, same reason, plus a rewrite
 *   would leave two live URLs serving the same page indefinitely.
 *
 * - `/onboarding*` → `/home?onboarding=1`: **redirect**. It changes
 *   visible state. `OnboardingOverlay` opens the tour off
 *   `useSearchParams().get("onboarding")`, which reads the *browser*
 *   URL — under a rewrite the client would never see the param and the
 *   tour would silently never open.
 *
 * - stub / removed prefixes → `/unavailable`: **rewrite**. This is the
 *   one genuinely correct rewrite. The resource is gone, so the
 *   "Page moved" body belongs at the URL the user actually asked for
 *   (same shape as Next's `notFound()` rendering `not-found.tsx` in
 *   place) rather than teleporting them to a different address that
 *   no longer says which URL was dead. Nothing on that page reads the
 *   pathname, and "no active sidebar item" is the correct rendering
 *   for a surface that has no nav entry.
 *
 * NOTE for callers: a rewrite gets no second pass through this
 * middleware, so the auth gate the redirect version inherited for free
 * has to be applied *before* rewriting. See `src/proxy.ts`.
 *
 * The live/stub prefix lists are the single source of truth in
 * portal-routes.ts (the auth-gate file) — imported here rather than
 * hand-duplicated, so this module's routing logic and the auth gate
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

/** How the middleware should serve a hub target. */
export type HubTargetMode = "redirect" | "rewrite";

export interface HubTarget {
  destination: string;
  /** `redirect` changes the visible URL; `rewrite` keeps it. */
  mode: HubTargetMode;
}

/**
 * Resolve a request path to its hub target, or `null` to pass through.
 * See the module docstring for why each mapping picks its mode.
 */
export function resolveHubTarget(
  pathname: string,
  search: string,
): HubTarget | null {
  const p = pathname.split("?")[0].split("#")[0];

  const fromLab = labToProductPath(p);
  if (fromLab) {
    return { destination: withSearch(fromLab, search), mode: "redirect" };
  }

  if (p === "/dashboard" || p.startsWith("/dashboard/")) {
    return { destination: withSearch("/home", search), mode: "redirect" };
  }

  // First-run entry — product home with soft-open tour. Merge the
  // incoming query with the hardcoded onboarding=1 param rather than
  // naively concatenating (the base path already has a `?`, so a plain
  // withSearch() call here would produce a second `?` and corrupt the
  // URL — see portal-hub-redirect.test history for the bug this fixes).
  if (p === "/onboarding" || p.startsWith("/onboarding/")) {
    const extra = search.replace(/^\?/, "");
    return {
      destination: extra
        ? `/home?onboarding=1&${extra}`
        : "/home?onboarding=1",
      mode: "redirect",
    };
  }

  if (p === "/rebuild" || p.startsWith("/rebuild/")) return null;
  if (p === "/unavailable" || p.startsWith("/unavailable/")) return null;
  if (isLiveProductPath(p)) return null;

  for (const prefix of STUB_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      // Keep the requested URL — see module docstring.
      return { destination: STUB_LAND, mode: "rewrite" };
    }
  }

  const exact = HUB_REDIRECT_RULES[p];
  if (exact) return { destination: exact.destination, mode: "redirect" };
  return null;
}

/**
 * Destination-only view of {@link resolveHubTarget}. Kept because the
 * route-contract tests and older callers assert on the string; new
 * callers that have to serve the response need the mode too.
 */
export function buildHubRedirectUrl(
  pathname: string,
  search: string,
): string | null {
  return resolveHubTarget(pathname, search)?.destination ?? null;
}
