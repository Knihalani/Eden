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
import { buildAgentIntegrationPrompt } from "@/lib/agent-integration-prompt";

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

describe("agent integration prompt", () => {
  const creds = { apiKey: "sk_eden_test", orgId: "org_test" };

  it("fills in the real credentials", () => {
    const prompt = buildAgentIntegrationPrompt(creds);
    expect(prompt).toContain("EDEN_API_KEY=sk_eden_test");
    expect(prompt).toContain("EDEN_ORG_ID=org_test");
    expect(prompt).not.toContain("<your-api-key>");
    expect(prompt).not.toContain("<your-org-id>");
  });

  it("falls back to placeholders before a key is minted", () => {
    const prompt = buildAgentIntegrationPrompt({ apiKey: null, orgId: null });
    expect(prompt).toContain("<your-api-key>");
    expect(prompt).toContain("<your-org-id>");
  });

  it("names both SDK packages and both doctor commands", () => {
    const prompt = buildAgentIntegrationPrompt(creds);
    expect(prompt).toContain("@eden-ai/sdk");
    expect(prompt).toContain("eden-sdk");
    expect(prompt).toContain("npx eden-doctor");
    expect(prompt).toContain("python -m eden_sdk.doctor");
  });

  it("keeps the verification gate and the secret-handling rule", () => {
    // Both are the point of the prompt rather than decoration: an agent
    // that reports success without a confirmed trace, or that commits the
    // key, is the specific failure this is written to prevent.
    const prompt = buildAgentIntegrationPrompt(creds);
    expect(prompt).toContain("Do not report success without that");
    expect(prompt).toContain("Do not hardcode the key");
    expect(prompt).toContain("https://edenobservability.com/traces");
  });

  it("emits no unresolved template holes", () => {
    const prompt = buildAgentIntegrationPrompt(creds);
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("[object Object]");
    expect(prompt).not.toMatch(/\$\{/);
  });
});
