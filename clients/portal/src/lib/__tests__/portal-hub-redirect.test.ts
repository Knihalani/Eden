import { describe, expect, it } from "vitest";
import { buildHubRedirectUrl } from "@/lib/portal-hub-redirect";
import { isOnboardingWizardPath } from "@/lib/onboarding-progress";
import { datasetHref } from "@/lib/portal-cross-links";

describe("portal hub redirect merge", () => {
  it("merges promote_trace and sets tab=datasets for /datasets", () => {
    const target = buildHubRedirectUrl(
      "/datasets",
      "?promote_trace=trace-abc",
    );
    expect(target).toBe("/evals?promote_trace=trace-abc&tab=datasets");
  });

  it("does not overwrite an existing tab param", () => {
    const target = buildHubRedirectUrl(
      "/datasets",
      "?tab=playgrounds&promote_trace=x",
    );
    expect(target).toBe("/evals?tab=playgrounds&promote_trace=x");
  });

  it("redirects bare /playgrounds to evals playgrounds tab", () => {
    expect(buildHubRedirectUrl("/playgrounds", "")).toBe(
      "/evals?tab=playgrounds",
    );
  });
});

describe("onboarding wizard path", () => {
  it("returns false for improvement-loop (keeps chrome)", () => {
    expect(isOnboardingWizardPath("/onboarding/improvement-loop")).toBe(false);
    expect(isOnboardingWizardPath("/onboarding")).toBe(false);
  });
});

describe("datasetHref hub URL", () => {
  it("uses evals datasets tab for list links", () => {
    expect(datasetHref()).toBe("/evals?tab=datasets");
    expect(datasetHref("ds-1")).toBe("/datasets/ds-1");
  });
});
