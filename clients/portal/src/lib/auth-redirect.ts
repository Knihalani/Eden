/**
 * Post-auth redirect helpers for Clerk sign-in / sign-up pages.
 *
 * Clerk already reads ``?redirect_url=`` ahead of ``fallbackRedirectUrl``,
 * but ``signUpForceRedirectUrl`` / ``signInForceRedirectUrl`` override that
 * query param when the user flips between sign-in and sign-up. We sanitize
 * the param (same-origin relative paths only) and wire *fallback* (never
 * force) cross-links so org-aware return URLs survive the flip.
 *
 * Orgless users still land on ``/dashboard`` (or a deep link); portal
 * chrome then sends them to ``/settings?tab=org`` when appropriate.
 */

/** Default after sign-in when no safe ``redirect_url`` is present. */
export const AUTH_SIGN_IN_FALLBACK = "/dashboard";

/**
 * Default after sign-up — dashboard first-run checklist only.
 * Product tour opens via Tour / Resume (``?onboarding=1``), not auto.
 */
export const AUTH_SIGN_UP_FALLBACK = "/dashboard";

const AUTH_ROUTE_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/invite",
] as const;

/**
 * True for Clerk / legacy auth surfaces where cookie banners and
 * post-login redirects should not bounce the user back into auth.
 */
export function isAuthPath(pathname: string): boolean {
  if (!pathname) return false;
  return AUTH_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Accept only same-app relative paths. Reject protocol-relative
 * (``//evil``), absolute URLs, and auth routes (would loop).
 */
export function sanitizeAuthRedirectUrl(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Absolute or protocol-relative → reject (open redirect).
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
    trimmed.startsWith("//")
  ) {
    return null;
  }

  // Must be a root-relative path.
  if (!trimmed.startsWith("/")) return null;

  // Strip hash; keep query (e.g. /docs-fill?op=fill).
  const pathOnly = trimmed.split("#")[0] ?? trimmed;
  if (!pathOnly.startsWith("/") || pathOnly.startsWith("//")) return null;

  const pathname = pathOnly.split("?")[0] ?? pathOnly;
  if (isAuthPath(pathname)) return null;

  return pathOnly;
}

export type AuthClerkRedirectProps = {
  /** Present only when ``?redirect_url`` sanitized cleanly. */
  forceRedirectUrl?: string;
  fallbackRedirectUrl: string;
  /** Cross-link to the other auth form — preserves redirect when set. */
  crossLinkUrl: string;
  /** Fallback for the other form; never force so ``redirect_url`` wins. */
  crossLinkFallbackRedirectUrl: string;
};

/**
 * Build Clerk redirect props for a sign-in or sign-up page.
 *
 * ``mode: "sign-in"`` → fallback dashboard; cross-link is sign-up.
 * ``mode: "sign-up"`` → fallback dashboard (tour opt-in); cross-link is sign-in.
 */
export function buildAuthClerkRedirectProps(
  redirectParam: string | null | undefined,
  mode: "sign-in" | "sign-up",
): AuthClerkRedirectProps {
  const safe = sanitizeAuthRedirectUrl(redirectParam);
  const fallback =
    mode === "sign-in" ? AUTH_SIGN_IN_FALLBACK : AUTH_SIGN_UP_FALLBACK;
  const otherPath = mode === "sign-in" ? "/sign-up" : "/sign-in";
  const otherFallback =
    mode === "sign-in" ? AUTH_SIGN_UP_FALLBACK : AUTH_SIGN_IN_FALLBACK;

  const crossLinkUrl = safe
    ? `${otherPath}?redirect_url=${encodeURIComponent(safe)}`
    : otherPath;

  return {
    ...(safe ? { forceRedirectUrl: safe } : {}),
    fallbackRedirectUrl: fallback,
    crossLinkUrl,
    crossLinkFallbackRedirectUrl: safe ?? otherFallback,
  };
}
