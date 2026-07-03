// Audit 2026-07-02 P-robots: allow marketing crawl, disallow
// portal/api routes (login required, no SEO value).

import type { MetadataRoute } from "next";

const PORTAL = process.env.NEXT_PUBLIC_PORTAL_URL
    || "https://portal.eden.example";

export default function robots(): MetadataRoute.Robots {
    return {
        rules: [
            {
                userAgent: "*",
                allow: ["/", "/pricing", "/about", "/contact", "/blog",
                        "/changelog", "/customers", "/careers",
                        "/privacy", "/terms", "/dpa", "/security",
                        "/subprocessors"],
                disallow: ["/portal/", "/api/", "/sign-in", "/sign-up",
                           "/forgot-password", "/reset-password",
                           "/invite/", "/onboarding/"],
            },
        ],
        sitemap: `${PORTAL}/sitemap.xml`,
    };
}
