// Audit 2026-07-02 P-robots: allow marketing crawl, disallow
// portal/api routes (login required, no SEO value).

import type { MetadataRoute } from "next";
import { MARKETING_SITEMAP_ROUTES } from "@/lib/marketing-routes";
import { absoluteSiteUrl } from "@/lib/site-origin";

// Match sitemap.ts — static at build so robots cannot 500 on bad env.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          ...MARKETING_SITEMAP_ROUTES,
          "/og.png",
          "/og-pricing.png",
        ],
        disallow: [
          "/portal/",
          "/api/",
          "/sign-in",
          "/sign-up",
          "/forgot-password",
          "/reset-password",
          "/invite/",
          "/onboarding/",
          "/docs-fill",
          "/home",
          "/dashboard",
          "/agents",
          "/traces",
          "/sessions",
          "/issues",
          "/alerts",
          "/signals",
          "/evals",
          "/improve",
          "/cost",
          "/agent",
          "/debugger",
          "/compare",
          "/settings",
          "/prompts",
          "/guardrails",
          "/shell",
          "/unavailable",
          "/rebuild",
          "/lab",
        ],
      },
    ],
    sitemap: absoluteSiteUrl("/sitemap.xml"),
  };
}
