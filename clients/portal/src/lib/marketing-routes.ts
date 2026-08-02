/**
 * Public marketing routes for SEO surfaces (sitemap + robots).
 * Portal/auth/api routes stay out of the index.
 */

export const MARKETING_SITEMAP_ROUTES = [
  "/",
  "/pricing",
  "/about",
  "/contact",
  "/changelog",
  "/privacy",
  "/terms",
  "/dpa",
  "/security",
  "/subprocessors",
  "/do-not-sell",
  "/status",
] as const;

export type MarketingSitemapRoute = (typeof MARKETING_SITEMAP_ROUTES)[number];
