import { describe, expect, it } from "vitest";
import { SITE_URL } from "@/lib/constants";
import {
  pricingProductJsonLd,
  softwareApplicationJsonLd,
} from "@/lib/seo";

describe("SoftwareApplication / Offer JSON-LD", () => {
  it("points SoftwareApplication.url at the homepage, not /sign-up", () => {
    const ld = softwareApplicationJsonLd();
    expect(ld.url).toBe(SITE_URL);
    expect(ld.url).not.toContain("/sign-up");
  });

  it("points Offer.url at /pricing (public marketing), not /sign-up", () => {
    const appOffer = softwareApplicationJsonLd().offers;
    const productOffer = pricingProductJsonLd().offers;

    expect(appOffer.url).toBe(`${SITE_URL}/pricing`);
    expect(productOffer.url).toBe(`${SITE_URL}/pricing`);
    expect(appOffer.url).not.toContain("/sign-up");
    expect(productOffer.url).not.toContain("/sign-up");
  });

  it("keeps Offer URLs absolute https", () => {
    for (const offer of [
      softwareApplicationJsonLd().offers,
      pricingProductJsonLd().offers,
    ]) {
      expect(offer.url).toMatch(/^https:\/\//);
    }
  });
});
