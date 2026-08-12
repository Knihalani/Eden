import { describe, expect, it } from "vitest";
import { SITE_URL } from "@/lib/constants";
import {
  aboutPageJsonLd,
  pricingProductJsonLd,
  softwareApplicationJsonLd,
  WHY_EDEN_COMPARISON,
  whyEdenComparisonItemListJsonLd,
  whyEdenWebPageJsonLd,
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

describe("Why Eden / About JSON-LD", () => {
  it("emits WebPage for /why-eden with absolute canonical URL", () => {
    const ld = whyEdenWebPageJsonLd();
    expect(ld["@type"]).toBe("WebPage");
    expect(ld.url).toBe(`${SITE_URL}/why-eden`);
    expect(ld.url).toMatch(/^https:\/\//);
    expect(ld.isPartOf.url).toBe(SITE_URL);
  });

  it("emits comparison ItemList matching WHY_EDEN_COMPARISON", () => {
    const ld = whyEdenComparisonItemListJsonLd();
    expect(ld["@type"]).toBe("ItemList");
    expect(ld.numberOfItems).toBe(WHY_EDEN_COMPARISON.length);
    expect(ld.itemListElement).toHaveLength(WHY_EDEN_COMPARISON.length);
    expect(ld.itemListElement[0]).toMatchObject({
      "@type": "ListItem",
      position: 1,
      name: WHY_EDEN_COMPARISON[0].name,
      description: WHY_EDEN_COMPARISON[0].description,
    });
  });

  it("emits AboutPage for /about with absolute canonical URL", () => {
    const ld = aboutPageJsonLd();
    expect(ld["@type"]).toBe("AboutPage");
    expect(ld.url).toBe(`${SITE_URL}/about`);
    expect(ld.url).toMatch(/^https:\/\//);
    expect(ld.about.name).toBe("Eden");
  });
});
