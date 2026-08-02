// Generate /sitemap.xml from the public marketing route map.
// Portal/api pages are excluded (login gate). Soft-launch: only list
// routes that actually exist under (marketing).

import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/constants";
import { MARKETING_SITEMAP_ROUTES } from "@/lib/marketing-routes";

const PORTAL =
  process.env.NEXT_PUBLIC_PORTAL_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  SITE_URL;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return MARKETING_SITEMAP_ROUTES.map((path) => ({
    url: `${PORTAL}${path}`,
    lastModified: now,
    changeFrequency: path === "/changelog" ? "weekly" : "monthly",
    priority: path === "/" ? 1.0 : path === "/pricing" ? 0.9 : 0.7,
  }));
}
