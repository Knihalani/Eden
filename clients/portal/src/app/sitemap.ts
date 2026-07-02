// Audit 2026-07-02 P-sitemap: generate /sitemap.xml from the
// route map. Marketing pages are public; portal/api pages are
// excluded from the index (login gate).

import type { MetadataRoute } from "next";

const PORTAL = process.env.NEXT_PUBLIC_PORTAL_URL
    || "https://portal.eden.example";

export default function sitemap(): MetadataRoute.Sitemap {
    const now = new Date();
    const marketingRoutes = [
        "/",
        "/pricing",
        "/about",
        "/contact",
        "/blog",
        "/changelog",
        "/customers",
        "/careers",
        "/privacy",
        "/terms",
        "/dpa",
        "/security",
        "/subprocessors",
    ];
    return marketingRoutes.map((path) => ({
        url: `${PORTAL}${path}`,
        lastModified: now,
        changeFrequency: "weekly",
        priority: path === "/" ? 1.0 : 0.7,
    }));
}
