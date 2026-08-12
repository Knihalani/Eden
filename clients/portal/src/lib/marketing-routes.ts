/**
 * Public marketing routes for SEO surfaces (sitemap + robots).
 * Portal/auth/api routes stay out of the index.
 *
 * Thin legal/utility pages (/privacy, /terms, /dpa, /subprocessors,
 * /do-not-sell) stay linked from the footer but are omitted here so
 * crawl budget focuses on money/vs/content pages. Those routes also
 * set `robots: { index: false, follow: true }` via marketingMetadata.
 *
 * /changelog is intentionally still listed — item 18 rebuilds it;
 * leave the stub indexable until then rather than inventing content.
 */

export const MARKETING_SITEMAP_ROUTES = [
  "/",
  "/pricing",
  "/about",
  "/why-eden",
  "/vs/langfuse",
  "/vs/helicone",
  "/vs/braintrust",
  "/contact",
  "/changelog",
  "/security",
  "/status",
] as const;

export type MarketingSitemapRoute = (typeof MARKETING_SITEMAP_ROUTES)[number];
