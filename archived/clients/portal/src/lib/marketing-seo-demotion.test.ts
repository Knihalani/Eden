import { describe, expect, it } from "vitest";
import { MARKETING_SITEMAP_ROUTES } from "@/lib/marketing-routes";
import { marketingMetadata } from "@/lib/seo";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/constants";

describe("marketing SEO demotion (item 17)", () => {
  const demoted = [
    "/privacy",
    "/terms",
    "/dpa",
    "/subprocessors",
    "/do-not-sell",
  ] as const;

  it("keeps thin legal pages out of the sitemap route map", () => {
    for (const path of demoted) {
      expect(MARKETING_SITEMAP_ROUTES).not.toContain(path);
    }
  });

  it("does not emit demoted legal locs in sitemap()", () => {
    const urls = sitemap().map((e) => e.url);
    for (const path of demoted) {
      expect(urls).not.toContain(`${SITE_URL}${path}`);
    }
    expect(urls).toContain(SITE_URL);
    expect(urls).toContain(`${SITE_URL}/security`);
    expect(urls).toContain(`${SITE_URL}/changelog`);
  });

  it("defaults marketingMetadata to index+follow", () => {
    const meta = marketingMetadata({
      path: "/about",
      title: "About",
      description: "About Eden",
    });
    expect(meta.robots).toEqual({ index: true, follow: true });
  });

  it("allows noindex+follow for demoted legal pages", () => {
    const meta = marketingMetadata({
      path: "/privacy",
      title: "Privacy",
      description: "Privacy summary",
      robots: { index: false, follow: true },
    });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});
