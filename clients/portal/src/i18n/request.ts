import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

/**
 * next-intl request config — loads the message bundle for the active
 * locale on every server render. Wired into `next.config.ts` via the
 * `next-intl/plugin` createNextIntlPlugin call so the build pipeline
 * picks it up.
 *
 * The locale itself is resolved by next-intl's middleware (cookie →
 * accept-language → default). We just look up the JSON bundle here.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});