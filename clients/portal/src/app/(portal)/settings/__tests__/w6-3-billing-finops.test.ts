/**
 * Wave 6.3 — Billing / FinOps free-only honesty.
 *
 * Stripe paid endpoints intentionally 503 while PAID_PLANS_ENABLED is
 * False. UI must not paint that as a broken ErrorState / Stripe outage.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import {
  PAID_PLANS_DISABLED_TITLE,
  featureGatedErrorCopy,
  isPaidPlansDisabledError,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

const FREE_ONLY_DETAIL =
  "Paid plans are not available yet. Eden is currently free-only.";

describe("W6-3 free-only 503 detection", () => {
  it("maps billing.py free-only detail to non-retryable not-available copy", () => {
    const err = new ApiError(503, "Service Unavailable", FREE_ONLY_DETAIL);
    expect(isPaidPlansDisabledError(err)).toBe(true);
    expect(isRetryableIntelligenceError(err)).toBe(false);
    expect(featureGatedErrorCopy(err, "Could not load billing").title).toBe(
      PAID_PLANS_DISABLED_TITLE,
    );
  });

  it("keeps Stripe-misconfig 503 retryable / not free-only", () => {
    const err = new ApiError(
      503,
      "Service Unavailable",
      "Stripe is not configured. Please set STRIPE_SECRET_KEY.",
    );
    expect(isPaidPlansDisabledError(err)).toBe(false);
    expect(isRetryableIntelligenceError(err)).toBe(true);
  });
});

describe("W6-3 stripe probe does not paint free-only as outage", () => {
  it("use-integration-status treats paid-plans-disabled 503 as available", () => {
    const src = read("hooks/use-integration-status.ts");
    expect(src).toContain("isPaidPlansDisabledError");
    expect(src).toMatch(
      /isPaidPlansDisabledError\(e\)[\s\S]*?return \{\s*available:\s*true/,
    );
  });
});

describe("W6-3 billing UI honesty", () => {
  it("billing-tab uses featureGatedErrorCopy (not raw error.message as ErrorState)", () => {
    const src = read("app/(portal)/settings/_components/billing-tab.tsx");
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("isPaidPlansDisabledError");
    expect(src).toContain("isRetryableIntelligenceError");
    expect(src).not.toMatch(/planQuery\.error\?\.message/);
  });

  it("billing-overview does not swallow getPlans into false $0", () => {
    const src = read("components/billing/billing-overview.tsx");
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("isPaidPlansDisabledError");
    expect(src).not.toMatch(/getPlans\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/);
  });

  it("budget page keeps gated ErrorState for intentional 503s", () => {
    const src = read("app/(portal)/optimization/budget/page.tsx");
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("isRetryableIntelligenceError");
  });

  it("finops explorer keeps gated ErrorState", () => {
    const src = read(
      "app/(portal)/optimization/_components/finops-explorer.tsx",
    );
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("isRetryableIntelligenceError");
  });
});
