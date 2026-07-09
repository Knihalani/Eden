import { defineRouting } from "next-intl/routing";

/**
 * Locale routing config for next-intl.
 *
 * Design notes:
 * - Two locales: `en` (default) and `de` (German). Add more here as
 *   translations are added.
 * - `localePrefix: "never"` — we don't use the `[locale]` route
 *   segment at all. Instead, `src/proxy.ts` owns the `/de/...`
 *   prefix: it detects a German-prefixed URL, sets the
 *   `NEXT_LOCALE=de` cookie, and rewrites the request to the
 *   unprefixed path. Pages stay at their canonical English URL,
 *   and `/de/...` is a stable, shareable mirror of the same page
 *   in German.
 * - Locale is also persisted via next-intl's cookie so the footer
 *   toggle (`useLocale() + router.replace`) keeps the same path in
 *   the address bar — the URL is intentionally not rewritten when
 *   the toggle is clicked.
 * - The cookie-based approach (no `[locale]` segment in the app dir)
 *   was chosen to avoid touching every existing route's file path —
 *   every existing page stays where it is, and translation is
 *   layered on top via `useTranslations()` / `getTranslations()`.
 */
export const routing = defineRouting({
  locales: ["en", "de"] as const,
  defaultLocale: "en",
  localePrefix: "never",
});

export type AppLocale = (typeof routing.locales)[number];
