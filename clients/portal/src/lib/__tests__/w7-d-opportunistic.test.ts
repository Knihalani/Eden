/**
 * W7-D — Opportunistic polish regressions:
 * - Hub empty CTAs use Button asChild (no nested Link/a > Button)
 * - Busy detail routes ship loading.tsx skeletons
 * - Settings tabs render NoOrgState instead of blank null
 * - Personal orgs soft-hide SCIM/SSO + org-wide 2FA enforcement UI
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W7-D nested Link/a hub navs", () => {
  it("agents / improve plans / improvement-loop use Button asChild (not Link>Button)", () => {
    for (const rel of [
      "app/(portal)/agents/page.tsx",
      "app/(portal)/improve/plans/page.tsx",
      "app/(portal)/onboarding/improvement-loop.tsx",
      "app/(portal)/improve/plans/[id]/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/Button asChild/);
      expect(src).not.toMatch(/<Link[^>]*>\s*<Button/);
      expect(src).not.toMatch(/<a [^>]*>\s*<Button/);
    }
  });
});

describe("W7-D loading skeletons on busy routes", () => {
  it("adds loading.tsx for debugger-session, session, and agent detail surfaces", () => {
    for (const rel of [
      "app/(portal)/debugger-sessions/[id]/loading.tsx",
      "app/(portal)/sessions/[sessionId]/loading.tsx",
      "app/(portal)/agents/[id]/artifacts/loading.tsx",
      "app/(portal)/agents/[id]/drift/loading.tsx",
      "app/(portal)/agents/[id]/ledger/loading.tsx",
      "app/(portal)/agents/[id]/book/loading.tsx",
    ]) {
      expect(existsSync(resolve(portalSrc, rel))).toBe(true);
      expect(read(rel)).toContain("LoadingSkeleton");
    }
  });
});

describe("W7-D NoOrgState on settings tabs", () => {
  it("roles + autonomous tabs render NoOrgState instead of blank null", () => {
    for (const rel of [
      "app/(portal)/settings/_components/roles-tab.tsx",
      "app/(portal)/settings/_components/autonomous-tab.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain("NoOrgState");
      expect(src).not.toMatch(/if\s*\(\s*!currentOrg\s*\)\s*return\s*null/);
    }
  });
});

describe("W7-D personal-org soft-hide", () => {
  it("settings soft-hides team-only tabs (SCIM) for personal orgs", () => {
    const src = read("app/(portal)/settings/page.tsx");
    expect(src).toContain("isTeamOnlyTab");
    expect(src).toMatch(/isTeamOnlyTab\(id\)\s*&&\s*isPersonalOrg/);
  });

  it("personal-org SCIM deep-link toast is not Admin only", () => {
    const src = read("app/(portal)/settings/page.tsx");
    expect(src).toContain("Team workspaces only");
  });

  it("security tab soft-hides org 2FA enforcement for personal orgs", () => {
    const src = read("app/(portal)/settings/_components/security-tab.tsx");
    expect(src).toContain("isPersonalWorkspace");
    expect(src).toContain("canUseTeamFeatures");
    expect(src).toContain("showWorkspaceEnforcement");
  });
});
