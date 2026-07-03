import { defineRouting } from "next-intl/routing";

/**
 * Locale routing config for next-intl.
 *
 * Design notes:
 * - Two locales: `en` (default) and `de` (German). Add more here as
 *   translations are added.
 * - `localePrefix: "as-needed"` means the default locale (`en`) is NOT
 *   prefixed in the URL (e.g. `/privacy` stays `/privacy`), while
 *   non-default locales get a prefix (`/de/privacy`). This keeps the
 *   marketing URL surface unchanged for English (no SEO churn) while
 *   still giving German users a clean `/de/...` mirror.
 * - Locale is persisted via next-intl's cookie; the footer toggle
 *   switches it by calling `setLocale()` from `useTransition()`.
 *
 * The cookie-based approach (no `[locale]` segment in the app dir)
 * was chosen to avoid touching every existing route's file path —
 * every existing page stays where it is, and translation is layered
 * on top via `useTranslations()` / `getTranslations()`.
 */
export const routing = defineRouting({
  locales: ["en", "de"] as const,
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type AppLocale = (typeof routing.locales)[number];