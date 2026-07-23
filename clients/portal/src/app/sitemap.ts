// Audit 2026-07-02 P-sitemap: generate /sitemap.xml from the
// route map. Marketing pages are public; portal/api pages are
// excluded from the index (login gate).
// Soft-launch: only list routes that actually exist.

import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/constants";

const PORTAL =
  process.env.NEXT_PUBLIC_PORTAL_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  SITE_URL;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const marketingRoutes = [
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
  ];
  return marketingRoutes.map((path) => ({
    url: `${PORTAL}${path}`,
    lastModified: now,
    changeFrequency: path === "/changelog" ? "weekly" : "monthly",
    priority: path === "/" ? 1.0 : 0.7,
  }));
}
