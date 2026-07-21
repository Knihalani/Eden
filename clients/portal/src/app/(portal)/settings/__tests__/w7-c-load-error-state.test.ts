/**
 * W7-C — Remaining load failures use in-page ErrorState + retry
 * (not toast-only). Mutation toasts stay.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W7-C load ErrorState sweep", () => {
  it("gateway tab uses ErrorState for model list load (not toast)", () => {
    const src = read("app/(portal)/settings/_components/gateway-tab.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load gateway models"');
    expect(src).toContain("Try again");
    expect(src).not.toMatch(/toast\.error\(["']Failed to load gateway models/);
  });

  it("security tab uses ErrorState for 2FA load (not toast)", () => {
    const src = read("app/(portal)/settings/_components/security-tab.tsx");
    expect(src).toContain('title="Could not load 2FA data"');
    expect(src).toContain("Try again");
    expect(src).not.toMatch(/toast\.error\([\s\S]*Failed to load 2FA data/);
  });

  it("security tab fails closed on org 2FA enforcement/members errors", () => {
    const src = read("app/(portal)/settings/_components/security-tab.tsx");
    // Soft-defaults hide outages as "not enforced" / "no members".
    expect(src).not.toMatch(
      /getOrg2FAEnforcementStatus\([^)]*\)\.catch\(\(\)\s*=>\s*\(\{\s*two_factor_enforced:\s*false\s*\}\)\)/,
    );
    expect(src).not.toMatch(
      /getOrgMembers2FAStatus\([^)]*\)\.catch\(\(\)\s*=>\s*\[\]/,
    );
    expect(src).toContain("api.getOrg2FAEnforcementStatus(orgId!)");
    expect(src).toContain("api.getOrgMembers2FAStatus(orgId!)");
    expect(src).toContain('title="Could not load 2FA data"');
  });

  it("members tab uses ErrorState for list load (not false empty)", () => {
    const src = read("app/(portal)/settings/_components/members-tab.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load members"');
    expect(src).toContain("Try again");
    expect(src).toContain("membersQuery.refetch()");
  });

  it("transfer ownership fails closed on members load (not empty list)", () => {
    const src = read(
      "app/(portal)/settings/_components/transfer-ownership-section.tsx",
    );
    expect(src).toContain('title="Could not load members"');
    expect(src).not.toMatch(/catch\s*\{[^}]*setMembers\(\[\]\)[^}]*\}\s*finally/);
    expect(src).toContain("membersError");
    expect(src).toContain("membersQuery.refetch()");
  });

  it("status tab uses ErrorState for platform status load", () => {
    const src = read("app/(portal)/settings/_components/status-tab.tsx");
    expect(src).toContain('title="Could not load status"');
    expect(src).toContain("setError(errorFromCaught");
    expect(src).not.toMatch(/toast\.error\([\s\S]*Failed to load status/);
  });

  it("account panel uses ErrorState for 2FA status load (not toast)", () => {
    const panel = read("app/(portal)/settings/_components/account-panel.tsx");
    const sections = read(
      "app/(portal)/settings/_components/account-panel-sections.tsx",
    );
    expect(sections).toContain('title="Could not load 2FA status"');
    expect(panel).toContain("twoFaError");
    expect(panel).not.toMatch(/toast\.error\(["']Could not load 2FA status/);
  });

  it("references tab uses ErrorState for list load (not toast)", () => {
    const src = read("app/(portal)/settings/_components/references-tab.tsx");
    expect(src).toContain('title="Could not load references"');
    expect(src).not.toMatch(/toast\.error\([\s\S]*Failed to load references/);
  });

  it("audit log tab uses ErrorState for load (not toast)", () => {
    const src = read("app/(portal)/audit-trail/_components/events-panel.tsx");
    expect(src).toContain('errorTitle="Could not load audit log"');
    expect(src).not.toMatch(/toast\.error\([\s\S]*Failed to load audit log/);
  });
});
