/**
 * Minimal analytics stub gated on cookie consent.
 *
 * - No-ops until the user has accepted cookies
 *   (``localStorage.eden_cookie_consent === "accepted"``).
 * - When ``NEXT_PUBLIC_PLAUSIBLE_DOMAIN`` is set and consent is
 *   granted, injects the Plausible script once.
 * - ``track(event, props?)`` is safe to call anywhere — it silently
 *   drops events until consent + Plausible are ready.
 *
 * Prefer this over shipping PostHog / marketing pixels by default.
 */

export type ConsentValue = "accepted" | "declined";

export const COOKIE_CONSENT_KEY = "eden_cookie_consent";

const PLAUSIBLE_SCRIPT_ID = "eden-plausible-script";

function readConsent(): ConsentValue | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(COOKIE_CONSENT_KEY);
    if (v === "accepted" || v === "declined") return v;
  } catch {
    // private mode / blocked storage
  }
  return null;
}

export function hasAnalyticsConsent(): boolean {
  return readConsent() === "accepted";
}

function plausibleDomain(): string | null {
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN?.trim();
  return domain || null;
}

/** Inject Plausible when consented + domain configured. Idempotent. */
export function initAnalytics(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!hasAnalyticsConsent()) return;

  const domain = plausibleDomain();
  if (!domain) return;
  if (document.getElementById(PLAUSIBLE_SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = PLAUSIBLE_SCRIPT_ID;
  script.defer = true;
  script.dataset.domain = domain;
  script.src = "https://plausible.io/js/script.js";
  document.head.appendChild(script);
}

/** Tear down analytics when the user declines / withdraws consent. */
export function teardownAnalytics(): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(PLAUSIBLE_SCRIPT_ID);
  if (el) el.remove();
}

/**
 * Apply a consent choice. Accept → init; decline → teardown.
 * Call this from the cookie banner (and Cookie preferences re-open).
 */
export function applyAnalyticsConsent(value: ConsentValue): void {
  if (value === "accepted") {
    initAnalytics();
  } else {
    teardownAnalytics();
  }
}

type PlausibleFn = (
  event: string,
  options?: { props?: Record<string, string | number | boolean> },
) => void;

/** Fire a custom event. No-ops without consent / Plausible. */
export function track(
  event: string,
  props?: Record<string, string | number | boolean>,
): void {
  if (typeof window === "undefined") return;
  if (!hasAnalyticsConsent()) return;
  const plausible = (window as unknown as { plausible?: PlausibleFn }).plausible;
  if (typeof plausible !== "function") return;
  try {
    plausible(event, props ? { props } : undefined);
  } catch {
    // never break the app for analytics
  }
}

/** Boot from an existing stored consent (e.g. on layout mount). */
export function bootAnalyticsFromStoredConsent(): void {
  if (hasAnalyticsConsent()) {
    initAnalytics();
  }
}
