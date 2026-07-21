// @vitest-environment node
/**
 * W2-23 — Orgless first-run UX: create-org is the obvious path,
 * tour does not claim it creates a workspace, dashboard/traces do
 * not show false empty product while org context is loading.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_TOUR_STEPS } from "@/lib/product-tour";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W2-23 NoOrgState create-org CTA", () => {
  it("makes Create workspace the primary path when not syncing", () => {
    const src = read("components/ui/no-org-state.tsx");
    expect(src).toContain('const CREATE_ORG_HREF = "/settings?tab=org"');
    expect(src).toContain("Create workspace");
    expect(src).toMatch(/product tour does not create or sync your workspace/i);
    // Default orgless copy must not claim workspace is already being set up.
    expect(src).toContain("orglessDescription");
    expect(src).not.toMatch(
      /orglessDescription\s*=\s*[\s\S]*being set up/,
    );
    // Syncing branch is separate from the create-org primary CTA.
    expect(src).toContain("Syncing your workspace…");
    expect(src).toContain("createOrgPrimary");
  });

  it("on timeout offers retry plus Workspace settings", () => {
    const src = read("components/ui/no-org-state.tsx");
    expect(src).toContain("Retry sync");
    expect(src).toContain("Open Workspace settings");
    expect(src).toContain("syncTimedOut");
  });
});

describe("W2-23 portal chrome + pages", () => {
  it("redirects orgless users (including dashboard) to settings?tab=org", () => {
    const chromeFx = read("hooks/use-portal-chrome-effects.ts");
    expect(chromeFx).toContain('router.replace("/settings?tab=org")');
    expect(chromeFx).toContain("isOrglessFriendly");
    // Dashboard must not be exempt — create-org is the landing path.
    expect(chromeFx).not.toMatch(
      /isOrglessFriendly\s*=\s*[\s\S]*path\s*===\s*["']\/dashboard["']/,
    );
    expect(chromeFx).toMatch(/path\.startsWith\(["']\/invite["']\)/);
    expect(chromeFx).toMatch(/path\s*===\s*["']\/settings["']/);
  });

  it("dashboard gates org loading before NoOrgState / empty product", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toMatch(/orgLoading\s*&&\s*!currentOrg/);
    expect(src).toContain("NoOrgState");
    expect(src).toContain("HomeDashboardSkeleton");
    expect(src).toMatch(/Create a workspace to open the dashboard/);
    expect(src).toMatch(/product tour does not create/);
  });

  it("traces gates org loading and avoids false empty when orgless", () => {
    const page = read("app/(portal)/traces/page.tsx");
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(page).toMatch(/hub\.orgLoading\s*&&\s*!hub\.currentOrg/);
    expect(page).toContain("NoOrgState");
    expect(page).toContain("LoadingSkeleton");
    expect(page).toMatch(/Create a workspace to view traces/);
    // Empty "Waiting for first event" must stay behind the org guard on the page.
    const noOrgIdx = page.indexOf("if (!hub.currentOrg && !hub.authError)");
    expect(noOrgIdx).toBeGreaterThan(-1);
    expect(list).toContain("<WaitingForFirstEvent");
  });

  it("onboarding overlay sends orgless ?onboarding=1 to create-org settings", () => {
    const src = read("components/onboarding/OnboardingOverlay.tsx");
    expect(src).toContain("if (!currentOrg)");
    expect(src).toContain('router.replace("/settings?tab=org")');
    expect(src).toContain("forceOpen");
  });

  it("product tour does not auto-open — only ?onboarding=1 / explicit Tour", () => {
    const src = read("components/onboarding/OnboardingOverlay.tsx");
    expect(src).toContain("Tour opens only on explicit ?onboarding=1");
    expect(src).toContain("shouldDeferBlockingOverlays");
    // Auto-open on incomplete tour must be gone.
    expect(src).not.toMatch(/if\s*\(\s*!isComplete\s*\)\s*\{[\s\S]*setOpen\(true\)/);
    expect(AUTH_SIGN_UP_FALLBACK_SNIP()).toBe("/dashboard");
  });
});

function AUTH_SIGN_UP_FALLBACK_SNIP(): string {
  const src = read("lib/auth-redirect.ts");
  const m = src.match(/AUTH_SIGN_UP_FALLBACK\s*=\s*"([^"]+)"/);
  return m?.[1] ?? "";
}

describe("W2-23 product tour honesty", () => {
  it("welcome step does not claim the tour creates a workspace", () => {
    const welcome = PRODUCT_TOUR_STEPS.find((s) => s.id === "welcome");
    expect(welcome?.body.toLowerCase()).toMatch(/does not create a workspace/);
    for (const step of PRODUCT_TOUR_STEPS) {
      expect(step.body.toLowerCase()).not.toMatch(
        /this (tour|walkthrough) creates (a |your )?workspace/,
      );
      expect(step.body.toLowerCase()).not.toMatch(
        /creates? (your |a )?workspace for you/,
      );
    }
  });

  it("org tab create copy denies tour as workspace creator", () => {
    const src = read("app/(portal)/settings/_components/org-tab.tsx");
    expect(src).toMatch(/product tour does not create or sync your workspace/i);
    expect(src).toContain("Create workspace");
  });
});
