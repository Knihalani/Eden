/**
 * Wave 5.3 — insights / signals / users: ErrorState vs false empty,
 * F48 signalsApi ↔ signals.py contracts, create/match UX.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../.."); // → clients/portal/src

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirror of signals list gate (keep in sync with signals/page.tsx). */
function showSignalsEmpty(opts: {
  loading: boolean;
  error: string | null;
  rowCount: number;
}): boolean {
  if (opts.error) return false;
  if (opts.loading) return false;
  return opts.rowCount === 0;
}

/** Mirror of users tab gate (sessions/goals/cohorts/segments). */
function showUsersTabEmpty(opts: {
  loading: boolean;
  error: string | null;
  rowCount: number;
}): boolean {
  if (opts.error) return false;
  if (opts.loading && opts.rowCount === 0) return false;
  return opts.rowCount === 0;
}

/** Mirror of insights overview gate. */
function showInsightsEmptyOnboarding(opts: {
  loading: boolean;
  isError: boolean;
  hasOverview: boolean;
  overviewEmpty: boolean;
}): boolean {
  if (opts.loading && !opts.hasOverview) return false;
  if (opts.isError && !opts.hasOverview) return false;
  if (!opts.hasOverview) return true;
  return opts.overviewEmpty;
}

describe("W5-3 signals F48 contract", () => {
  it("signalsApi paths/bodies match signals.py (no compile)", () => {
    const src = read("lib/api/resources.ts");
    const block = src.split("const signalsApi")[1]?.split("const debuggerApi")[0] ?? "";
    expect(block).toContain("`/orgs/${orgId}/signals`");
    expect(block).toContain("description: string");
    expect(block).toContain("enabled?: boolean");
    expect(block).toContain("/signals/${signalId}/match");
    expect(block).toContain("body: JSON.stringify({ value })");
    expect(block).toContain("/signals/seed-defaults");
    expect(block).not.toContain("compile:");
    expect(block).not.toContain("/compile");
    expect(src).toContain("interface CompiledRule");
    expect(src).toMatch(/metric:\s*string/);
    expect(src).toMatch(/window_hours:\s*number/);
    expect(src).toMatch(/keywords:\s*string\[\]/);
  });

  it("signals page create/match UX: description create, compiled rule, match result panel", () => {
    const src = read("app/(portal)/signals/page.tsx");
    expect(src).toContain("signalsApi.create");
    expect(src).toContain("signalsApi.match");
    expect(src).toContain("signalsApi.seedDefaults");
    expect(src).toContain('data-testid="signals-last-created"');
    expect(src).toContain('data-testid="signals-last-match"');
    expect(src).toContain("setSeeding");
    expect(src).toContain("Compiled rule");
    expect(src).not.toContain("compile(");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load signals");
    expect(src).toContain("Try again");
  });

  it("does not show empty table while loading or on list error", () => {
    expect(
      showSignalsEmpty({ loading: true, error: null, rowCount: 0 }),
    ).toBe(false);
    expect(
      showSignalsEmpty({ loading: false, error: "boom", rowCount: 0 }),
    ).toBe(false);
    expect(
      showSignalsEmpty({ loading: false, error: null, rowCount: 0 }),
    ).toBe(true);
  });
});

describe("W5-3 users ErrorState vs false empty", () => {
  it("uses ErrorState with retry per active tab (not banner+empty)", () => {
    const src = read("app/(portal)/users/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load sessions");
    expect(src).toContain("Could not load goals");
    expect(src).toContain("Could not load cohorts");
    expect(src).toContain("Could not load segments");
    expect(src).toContain("activeTabError");
    expect(src).toContain("Try again");
    // Stale cross-tab OR of all query errors must not drive the banner.
    expect(src).not.toMatch(
      /sessionsQuery\.error\s*\?\?\s*goalsQuery\.error\s*\?\?\s*cohortsQuery\.error/,
    );
  });

  it("does not show empty while loading or on tab error", () => {
    expect(
      showUsersTabEmpty({ loading: true, error: null, rowCount: 0 }),
    ).toBe(false);
    expect(
      showUsersTabEmpty({ loading: false, error: "503", rowCount: 0 }),
    ).toBe(false);
    expect(
      showUsersTabEmpty({ loading: false, error: null, rowCount: 0 }),
    ).toBe(true);
  });
});

describe("W5-3 insights ErrorState vs false empty", () => {
  it("overview prefers ErrorState + retry when load fails without data", () => {
    const src = read("app/(portal)/insights/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load insights");
    expect(src).toContain("isError && !overview");
    expect(src).toContain("Try again");
  });

  it("closed-loop ErrorState includes retry CTA", () => {
    const src = read("app/(portal)/insights/page.tsx");
    expect(src).toContain("Could not load correlation data");
    expect(src).toContain("correlationQuery.refetch()");
    expect(src).toMatch(/if \(isError\)/);
  });

  it("does not show onboarding empty on overview error", () => {
    expect(
      showInsightsEmptyOnboarding({
        loading: false,
        isError: true,
        hasOverview: false,
        overviewEmpty: true,
      }),
    ).toBe(false);
    expect(
      showInsightsEmptyOnboarding({
        loading: true,
        isError: false,
        hasOverview: false,
        overviewEmpty: true,
      }),
    ).toBe(false);
    expect(
      showInsightsEmptyOnboarding({
        loading: false,
        isError: false,
        hasOverview: false,
        overviewEmpty: true,
      }),
    ).toBe(true);
  });
});
