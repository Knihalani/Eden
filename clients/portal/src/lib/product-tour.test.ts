import { describe, expect, it } from "vitest";
import {
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_TOTAL,
  tourIndexFromOnboardingStep,
  tourStepApiValue,
} from "@/lib/product-tour";
import {
  buildQuickstartSnippet,
  QUICKSTART_LANGS,
} from "@/lib/quickstart-snippets";

describe("product tour SoT", () => {
  it("walks welcome → home → traces → api-keys → get-started", () => {
    expect(PRODUCT_TOUR_STEPS.map((s) => s.id)).toEqual([
      "welcome",
      "home",
      "traces",
      "api-keys",
      "get-started",
    ]);
    expect(PRODUCT_TOUR_TOTAL).toBe(5);
    expect(PRODUCT_TOUR_STEPS[4]?.kind).toBe("finish");
    expect(PRODUCT_TOUR_STEPS[3]?.href).toBe("/settings?mode=keys");
    expect(PRODUCT_TOUR_STEPS[3]?.ctaHref).toBeUndefined();
    expect(PRODUCT_TOUR_STEPS[1]?.targetId).toBe("home");
    expect(PRODUCT_TOUR_STEPS[2]?.targetId).toBe("traces");
    expect(PRODUCT_TOUR_STEPS[3]?.targetId).toBe("api-keys");
  });

  it("maps legacy step names onto the new index", () => {
    expect(tourIndexFromOnboardingStep("install")).toBe(4);
    expect(tourIndexFromOnboardingStep("tour:traces")).toBe(2);
    expect(tourStepApiValue(4)).toBe("done");
  });
});

describe("quickstart snippets", () => {
  it("fills api key and org into every language", () => {
    expect(QUICKSTART_LANGS.map((l) => l.id)).toEqual([
      "python",
      "typescript",
      "bash",
    ]);
    const creds = { apiKey: "sk_eden_test", orgId: "org_test" };
    for (const lang of QUICKSTART_LANGS) {
      const snip = buildQuickstartSnippet(lang.id, creds);
      expect(snip).toContain("sk_eden_test");
      expect(snip).toContain("org_test");
    }
  });
});
