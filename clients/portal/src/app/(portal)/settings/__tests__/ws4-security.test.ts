/**
 * Wave 4 — Security leaf: clear 2FA / workspace enforcement, kit Switch + Dialog,
 * personal soft-hide, evidence markers (S10 / M14 / S23).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS4 Security leaf", () => {
  const security = read("app/(portal)/settings/_components/security-tab.tsx");
  const setup = read("app/(portal)/settings/_components/2fa-setup-dialog.tsx");

  it("exports WS4_SECURITY_COMPLETED and data-ws4-security", () => {
    expect(security).toContain("WS4_SECURITY_COMPLETED = true");
    expect(security).toContain('data-ws4-security="completed"');
  });

  it("uses kit Switch for workspace 2FA enforcement (no hand-rolled toggle)", () => {
    expect(security).toContain('from "@/components/ui/switch"');
    expect(security).toContain("<Switch");
    expect(security).toContain("Workspace 2FA enforcement");
    expect(security).not.toMatch(
      /relative w-12 h-6 rounded-full transition-colors/,
    );
    expect(security).not.toMatch(
      /enforcementStatus \? "bg-\[var\(--accent\)\]" : "bg-\[var\(--border-default\)\]"/,
    );
  });

  it("uses kit Dialog + SettingsCard + DangerZone; no raw Radix Dialog", () => {
    expect(security).toContain('from "@/components/ui/dialog"');
    expect(security).not.toContain("@radix-ui/react-dialog");
    expect(security).toContain('from "@/components/settings/settings-card"');
    expect(security).toContain("<SettingsCard");
    expect(security).toContain("<DangerZone");
    expect(setup).toContain('from "@/components/ui/dialog"');
    expect(setup).not.toContain("@radix-ui/react-dialog");
    expect(setup).toContain("data-ws4-security-setup");
  });

  it("personal-aware: soft-hides enforcement; workspace copy (not organization)", () => {
    expect(security).toContain("isPersonalWorkspace");
    expect(security).toContain("canUseTeamFeatures");
    expect(security).toContain("showWorkspaceEnforcement");
    expect(security).toContain("data-ws4-security-personal");
    expect(security).toContain("Workspace-wide 2FA enforcement is available on team workspaces");
    expect(security).not.toContain("Organization 2FA Enforcement");
    expect(security).not.toContain("Secure your account and organization");
    expect(security).not.toMatch(/access the organization/);
    expect(security).not.toMatch(/enforced for this organization/);
  });

  it("keeps permission gate + fail-closed enforcement/members loads", () => {
    expect(security).toContain('hasPermission("settings:edit")');
    expect(security).toContain("api.getOrg2FAEnforcementStatus(orgId!)");
    expect(security).toContain("api.getOrgMembers2FAStatus(orgId!)");
    expect(security).toContain('title="Could not load 2FA data"');
  });
});
