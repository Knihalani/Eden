import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  FEATURE_NOT_ENABLED_MESSAGE,
  FEATURE_NOT_ENABLED_TITLE,
  NOT_IMPLEMENTED_TITLE,
  PAID_PLANS_DISABLED_MESSAGE,
  PAID_PLANS_DISABLED_TITLE,
  assertOkEnvelope,
  featureGatedErrorCopy,
  featureGatedMessage,
  isFeatureFlagOffError,
  isNotImplementedError,
  isPaidPlansDisabledError,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";

describe("feature-flag-error", () => {
  it("treats require_feature_flag 404 Not Found as flag-off", () => {
    expect(isFeatureFlagOffError(new ApiError(404, "Not Found"))).toBe(true);
    expect(
      isFeatureFlagOffError(
        new ApiError(404, "We couldn't find what you're looking for.", "Not Found"),
      ),
    ).toBe(true);
  });

  it("treats explicit kill-switch / code signals as flag-off", () => {
    expect(
      isFeatureFlagOffError(
        new ApiError(503, "Unavailable", "improvement_agent_v1 disabled for this org"),
      ),
    ).toBe(true);
    expect(
      isFeatureFlagOffError(
        new ApiError(503, "Unavailable", "off", "feature_disabled"),
      ),
    ).toBe(true);
  });

  it("does not treat bare 404/503 or repo gaps as flag-off", () => {
    expect(isFeatureFlagOffError(new ApiError(404, "plan not found"))).toBe(false);
    expect(isFeatureFlagOffError(new ApiError(503, "Unavailable"))).toBe(false);
    expect(
      isFeatureFlagOffError(
        new ApiError(503, "Unavailable", "repo_not_connected"),
      ),
    ).toBe(false);
    expect(isFeatureFlagOffError(new ApiError(500, "boom"))).toBe(false);
    expect(isFeatureFlagOffError(new Error("Not Found"))).toBe(false);
  });

  it("maps billing free-only 503 to Paid plans not available yet", () => {
    const err = new ApiError(
      503,
      "Service Unavailable",
      "Paid plans are not available yet. Eden is currently free-only.",
    );
    expect(isPaidPlansDisabledError(err)).toBe(true);
    expect(isRetryableIntelligenceError(err)).toBe(false);
    expect(featureGatedErrorCopy(err, "Could not load").title).toBe(
      PAID_PLANS_DISABLED_TITLE,
    );
    expect(featureGatedErrorCopy(err, "Could not load").message).toBe(
      PAID_PLANS_DISABLED_MESSAGE,
    );
    expect(featureGatedMessage(err, "fallback")).toBe(PAID_PLANS_DISABLED_TITLE);
  });

  it("does not treat Stripe-not-configured 503 as free-only dormancy", () => {
    const err = new ApiError(
      503,
      "Service Unavailable",
      "Stripe is not configured. Please set STRIPE_SECRET_KEY.",
    );
    expect(isPaidPlansDisabledError(err)).toBe(false);
    expect(isRetryableIntelligenceError(err)).toBe(true);
  });

  it("returns Feature not enabled copy for gated failures", () => {
    const copy = featureGatedErrorCopy(
      new ApiError(404, "Not Found"),
      "Could not load",
    );
    expect(copy.title).toBe(FEATURE_NOT_ENABLED_TITLE);
    expect(copy.message).toBe(FEATURE_NOT_ENABLED_MESSAGE);
    expect(
      featureGatedMessage(
        new ApiError(503, "x", "disabled for this org"),
        "fallback",
      ),
    ).toBe(FEATURE_NOT_ENABLED_TITLE);
  });

  it("maps 501 / not_implemented to Not available yet", () => {
    expect(isNotImplementedError(new ApiError(501, "Not Implemented"))).toBe(true);
    expect(
      isNotImplementedError(new Error("Stub registered; implementation pending")),
    ).toBe(true);
    expect(featureGatedErrorCopy(new ApiError(501, "x"), "Could not load").title).toBe(
      NOT_IMPLEMENTED_TITLE,
    );
    expect(isRetryableIntelligenceError(new ApiError(501, "x"))).toBe(false);
    expect(isRetryableIntelligenceError(new ApiError(500, "boom"))).toBe(true);
  });

  it("assertOkEnvelope rejects non-ok intelligence stubs", () => {
    expect(() =>
      assertOkEnvelope({ status: "not_implemented", data: null }, "fallback"),
    ).toThrow(/Stub registered|implementation pending/);
    expect(assertOkEnvelope({ status: "ok", data: { a: 1 } }, "fallback")).toEqual({
      a: 1,
    });
  });

  it("passes through non-gate errors", () => {
    const err = new ApiError(422, "bad input");
    const copy = featureGatedErrorCopy(err, "Could not load");
    expect(copy.title).toBe("Could not load");
    expect(copy.message).toBe("bad input");
    expect(featureGatedMessage(err, "fallback")).toBe("bad input");
    expect(featureGatedMessage(new ApiError(503, "x"), "fallback")).toBe("x");
  });
});
