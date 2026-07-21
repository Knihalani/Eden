/**
 * Wave 5 — API keys + Billing evidence (S11 / S23).
 * Keys half owned here; billing asserts append in same file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS5 API keys leaf", () => {
  const tab = read("app/(portal)/settings/_components/api-keys-tab.tsx");
  const create = read(
    "app/(portal)/settings/_components/api-keys-create-panel.tsx",
  );
  const creds = read(
    "app/(portal)/settings/_components/api-keys-sdk-credentials.tsx",
  );

  it("evidence markers data-ws5-keys + WS5_KEYS_COMPLETED", () => {
    expect(tab).toContain("data-ws5-keys");
    expect(tab).toContain("WS5_KEYS_COMPLETED");
  });

  it("reveal-once secret UX after create", () => {
    expect(create).toContain("data-ws5-keys-secret");
    expect(create).toContain("shown once");
    expect(create).toContain("hides the key permanently");
  });

  it("one primary Create API key CTA via kit Button", () => {
    expect(create).toContain('from "@/components/ui/button"');
    expect(create).toContain("data-ws5-keys-create");
    expect(create).toContain("Create API key");
    expect(create).not.toMatch(
      /className="min-h-11 px-2 text-sm text-\[var\(--accent\)\]/,
    );
    const primaryMatches = [...create.matchAll(/Create API key/g)];
    expect(primaryMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("workspace-linked empty / permission copy (no under Organization)", () => {
    expect(tab).not.toContain("under Organization");
    expect(tab).toMatch(/workspace is not linked|create a workspace/i);
    expect(tab).toContain("workspace owners and admins");
  });

  it("create panel precedes SDK credentials in tab composition", () => {
    const createIdx = tab.indexOf("ApiKeysCreatePanel");
    const sdkIdx = tab.indexOf("ApiKeysSdkCredentials");
    expect(createIdx).toBeGreaterThan(-1);
    expect(sdkIdx).toBeGreaterThan(createIdx);
    expect(creds).toContain("SDK credentials");
  });

  it("leaf orchestrator ≤400 LOC after peel", () => {
    const lines = tab.split("\n").length;
    expect(lines).toBeLessThanOrEqual(400);
  });
});

describe("WS5 Billing leaf", () => {
  const tab = read("app/(portal)/settings/_components/billing-tab.tsx");
  const limits = read(
    "app/(portal)/settings/_components/plan-limits-display.tsx",
  );

  it("evidence markers data-ws5-billing + WS5_BILLING_COMPLETED", () => {
    expect(tab).toContain("data-ws5-billing");
    expect(tab).toContain("WS5_BILLING_COMPLETED");
    expect(tab).toContain("data-ws5-billing-cta");
  });

  it("empty state uses Select a workspace (not organization)", () => {
    expect(tab).toContain("Select a workspace");
    expect(tab).not.toContain("Select an organization");
  });

  it("plan card + PlanLimitsDisplay; no icon clutter strip", () => {
    expect(tab).toContain("PlanLimitsDisplay");
    expect(tab).toContain("Spending this month");
    expect(tab).toContain('from "./plan-limits-display"');
    expect(limits).toContain("data-ws5-plan-limits");
    expect(tab).not.toMatch(/icon=\{Users\}/);
    expect(tab).not.toMatch(/icon=\{Code\}/);
    expect(tab).not.toMatch(/icon=\{Briefcase\}/);
  });

  it("one primary CTA via kit Button", () => {
    expect(tab).toContain('from "@/components/ui/button"');
    expect(tab).toContain("SUPPORT_EMAIL");
    expect(tab).toContain("Request more headroom");
    expect(tab).toContain('variant="default"');
    expect(tab).toContain("data-ws5-billing-cta");
    // Retry stays quiet; only one solid default CTA in the leaf.
    const defaultVariants = [...tab.matchAll(/variant="default"/g)];
    expect(defaultVariants.length).toBe(1);
    expect(tab).not.toMatch(/bg-\[var\(--accent\)\][^"\n]*px-/);
  });

  it("keeps calm spend typography (Wave 9 contract)", () => {
    expect(tab).toContain("text-2xl font-semibold");
    expect(tab).not.toContain("text-4xl font-bold");
  });

  it("preserves free-only honesty helpers", () => {
    expect(tab).toContain("featureGatedErrorCopy");
    expect(tab).toContain("isPaidPlansDisabledError");
    expect(tab).toContain("isRetryableIntelligenceError");
  });
});
