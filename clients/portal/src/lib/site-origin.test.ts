import { afterEach, describe, expect, it } from "vitest";
import { SITE_URL } from "@/lib/constants";
import { MARKETING_SITEMAP_ROUTES } from "@/lib/marketing-routes";
import { absoluteSiteUrl, getSiteOrigin } from "@/lib/site-origin";
import sitemap from "@/app/sitemap";

const ENV_KEYS = ["NEXT_PUBLIC_PORTAL_URL", "NEXT_PUBLIC_SITE_URL"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("getSiteOrigin", () => {
  it("falls back to SITE_URL when env is missing", () => {
    expect(getSiteOrigin({})).toBe(SITE_URL);
  });

  it("prefers NEXT_PUBLIC_PORTAL_URL over SITE_URL", () => {
    expect(
      getSiteOrigin({
        NEXT_PUBLIC_PORTAL_URL: "https://preview.example.com/app/",
      }),
    ).toBe("https://preview.example.com");
  });

  it("never throws on invalid env — returns SITE_URL", () => {
    const bad = [
      "",
      "   ",
      "undefined",
      "null",
      "not-a-url",
      "://missing-scheme",
      "ftp://wrong.protocol",
      "https://",
    ];
    for (const value of bad) {
      expect(
        getSiteOrigin({
          NEXT_PUBLIC_PORTAL_URL: value,
          NEXT_PUBLIC_SITE_URL: value,
        }),
      ).toBe(SITE_URL);
    }
  });

  it("uses NEXT_PUBLIC_SITE_URL when portal URL is invalid", () => {
    expect(
      getSiteOrigin({
        NEXT_PUBLIC_PORTAL_URL: "bogus",
        NEXT_PUBLIC_SITE_URL: "https://edenobservability.com/",
      }),
    ).toBe("https://edenobservability.com");
  });
});

describe("absoluteSiteUrl", () => {
  it("omits trailing slash on the homepage loc", () => {
    expect(absoluteSiteUrl("/", {})).toBe(SITE_URL);
  });

  it("joins path segments without doubling slashes", () => {
    expect(absoluteSiteUrl("/pricing", {})).toBe(`${SITE_URL}/pricing`);
  });
});

describe("sitemap() hardening", () => {
  it("emits valid absolute https locs even when env URLs are garbage", () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = "not a url";
    process.env.NEXT_PUBLIC_SITE_URL = "://broken";

    const entries = sitemap();
    expect(entries).toHaveLength(MARKETING_SITEMAP_ROUTES.length);

    for (const entry of entries) {
      expect(() => new URL(entry.url)).not.toThrow();
      const url = new URL(entry.url);
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe(SITE_URL);
      expect(Number.isNaN(entry.lastModified?.valueOf() ?? NaN)).toBe(false);
    }

    const home = entries.find((e) => e.url === SITE_URL);
    expect(home).toBeDefined();
    expect(home?.priority).toBe(1);
  });
});
