/**
 * Wave 5.1 — Optimization + Guardrails honesty.
 *
 * - Envelope not_implemented / flag-off → ErrorState (not false empty / $0)
 * - Outcomes analytics KPIs never paint false zeros on load failure
 * - Predict tabs stay wired (live Cat 13) but assertOkEnvelope
 * - Guardrails scan/policy ErrorState; no toast-only failures
 * - Budget poll copy matches refetchInterval
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import {
  NOT_IMPLEMENTED_TITLE,
  assertOkEnvelope,
  featureGatedErrorCopy,
  isNotImplementedError,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5-1 assertOkEnvelope + 501 honesty", () => {
  it("throws on not_implemented so callers cannot false-empty", () => {
    expect(() =>
      assertOkEnvelope(
        { status: "not_implemented", message: "Stub registered; implementation pending", data: null },
        "fallback",
      ),
    ).toThrow(/Stub registered|implementation pending/);
  });

  it("returns data on ok", () => {
    expect(
      assertOkEnvelope({ status: "ok", data: { departments: [] } }, "fallback"),
    ).toEqual({ departments: [] });
  });

  it("maps HTTP 501 to Not available yet without retry", () => {
    const err = new ApiError(501, "Not Implemented");
    expect(isNotImplementedError(err)).toBe(true);
    expect(isRetryableIntelligenceError(err)).toBe(false);
    expect(featureGatedErrorCopy(err, "Could not load").title).toBe(
      NOT_IMPLEMENTED_TITLE,
    );
  });
});

describe("W5-1 outcomes ErrorState vs false-zero KPIs", () => {
  it("analytics query uses assertOkEnvelope and ErrorState", () => {
    const src = read("app/(portal)/optimization/outcomes/page.tsx");
    expect(src).toContain("assertOkEnvelope");
    expect(src).toContain("analyticsUnavailable");
    expect(src).toContain("Could not load outcomes analytics");
    expect(src).toMatch(/analyticsLoading \|\| analyticsUnavailable/);
    expect(src).toContain('analyticsUnavailable ? "unavailable"');
  });

  it("departments load failure uses ErrorState with gated retry", () => {
    const src = read("app/(portal)/optimization/outcomes/page.tsx");
    expect(src).toContain("isRetryableIntelligenceError");
    expect(src).toContain("Could not load departments");
  });
});

describe("W5-1 predict tabs + envelope honesty", () => {
  it("keeps quality/drift/cost/capacity/risk tabs (live Cat 13)", () => {
    const src = read("app/(portal)/optimization/predict/page.tsx");
    expect(src).toContain('value="quality"');
    expect(src).toContain('value="drift"');
    expect(src).toContain('value="cost"');
    expect(src).toContain('value="capacity"');
    expect(src).toContain('value="risk"');
  });

  it("all predict fetches assertOkEnvelope before rendering charts", () => {
    const src = read("app/(portal)/optimization/predict/page.tsx");
    expect(src.match(/assertOkEnvelope/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(src).toContain("isRetryableIntelligenceError");
  });
});

describe("W5-1 finops + budget honesty", () => {
  it("finops uses featureGatedErrorCopy (not String(error))", () => {
    const src = read("app/(portal)/optimization/_components/finops-explorer.tsx");
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("isRetryableIntelligenceError");
    expect(src).not.toMatch(/message=\{String\(error\)\}/);
  });

  it("budget ErrorState is feature-gated and poll copy matches 30s", () => {
    const src = read("app/(portal)/optimization/budget/page.tsx");
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("Polls every 30s");
    expect(src).toContain("refetchInterval: 30_000");
    expect(src).not.toContain("Polls every 5s");
  });
});

describe("W5-1 optimization hub tabs are wired", () => {
  it("Cost hub exposes cost/budget/outcomes/predict/advisor without dead stubs", () => {
    const src = read("app/(portal)/optimization/page.tsx");
    for (const tab of ["cost", "budget", "outcomes", "predict", "advisor"]) {
      expect(src).toContain(`value="${tab}"`);
      expect(src).toContain(`tab === "${tab}"`);
    }
  });
});

describe("W5-1 guardrails ErrorState (W5-A/W6-B)", () => {
  it("policies and scan history use ErrorState with gated retry", () => {
    const src = read("app/(portal)/guardrails/page.tsx");
    expect(src).toContain("Could not load policies");
    expect(src).toContain("Could not load injection history");
    expect(src).toContain("Could not load PII history");
    expect(src).toContain("NOT_IMPLEMENTED_TITLE");
    expect(src).toContain("FEATURE_NOT_ENABLED_TITLE");
    expect(src).not.toMatch(/Couldn't load scan history/);
  });

  it("listPolicies client throws on non-ok envelope", () => {
    const src = read("lib/api/resources.ts");
    expect(src).toMatch(
      /listPolicies:[\s\S]*?envelope\.status !== "ok"[\s\S]*?throw new Error/,
    );
  });
});
