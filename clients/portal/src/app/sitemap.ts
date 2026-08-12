// Generate /sitemap.xml from the public marketing route map.
// Portal/api pages are excluded (login gate). Soft-launch: only list
// routes that actually exist under (marketing).

import type { MetadataRoute } from "next";
import { MARKETING_SITEMAP_ROUTES } from "@/lib/marketing-routes";
import { absoluteSiteUrl } from "@/lib/site-origin";

// Build-time static file — avoids request-time serverless flakes that
// previously surfaced as intermittent HTTP 500s on /sitemap.xml.
export const dynamic = "force-static";

/**
 * Stable lastModified — the marketing surface changes rarely and a
 * fixed date (rather than `new Date()` per build) keeps the sitemap
 * byte-stable so crawlers don't re-crawl on every deploy. Bump when a
 * page's content materially changes.
 */
const LAST_MODIFIED = new Date("2026-08-11T00:00:00Z");

type SitemapOverrides = Partial<Omit<MetadataRoute.Sitemap[number], "url">>;

const ROUTE_META: Partial<Record<(typeof MARKETING_SITEMAP_ROUTES)[number], SitemapOverrides>> = {
  "/": { changeFrequency: "monthly", priority: 1 },
  "/pricing": { changeFrequency: "monthly", priority: 0.9 },
  "/why-eden": { changeFrequency: "monthly", priority: 0.8 },
  "/about": { changeFrequency: "yearly", priority: 0.7 },
  "/contact": { changeFrequency: "yearly", priority: 0.6 },
  "/changelog": { changeFrequency: "weekly", priority: 0.6 },
  "/status": { changeFrequency: "hourly", priority: 0.5 },
  "/security": { changeFrequency: "yearly", priority: 0.6 },
  "/privacy": { changeFrequency: "yearly", priority: 0.4 },
  "/terms": { changeFrequency: "yearly", priority: 0.4 },
  "/dpa": { changeFrequency: "yearly", priority: 0.4 },
  "/subprocessors": { changeFrequency: "yearly", priority: 0.4 },
  "/do-not-sell": { changeFrequency: "yearly", priority: 0.4 },
};

export default function sitemap(): MetadataRoute.Sitemap {
  return MARKETING_SITEMAP_ROUTES.map((path) => ({
    // Root renders canonical without a trailing slash — keep the <loc>
    // identical so crawlers never see two spellings of the homepage.
    url: absoluteSiteUrl(path),
    lastModified: LAST_MODIFIED,
    ...ROUTE_META[path],
  }));
}
