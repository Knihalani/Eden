/**
 * Wave 4 — Members + Security evidence (members half).
 * Security leaf asserts filled by peer agent; members path locked here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canInviteMembers,
  isPersonalWorkspace,
} from "@/lib/workspace-mode";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS4 Members — workspace-mode invite gate", () => {
  it("canInviteMembers is false for personal workspaces", () => {
    expect(isPersonalWorkspace({ is_personal: true })).toBe(true);
    expect(canInviteMembers({ is_personal: true })).toBe(false);
    expect(canInviteMembers({ is_personal: false })).toBe(true);
  });
});

describe("WS4 Members — members-tab", () => {
  const src = read("app/(portal)/settings/_components/members-tab.tsx");

  it("exports WS4_MEMBERS_COMPLETED and data-ws4-members", () => {
    expect(src).toContain("WS4_MEMBERS_COMPLETED");
    expect(src).toContain("data-ws4-members");
  });

  it("gates invite UI with members:invite + canInviteMembers", () => {
    expect(src).toContain('hasPermission("members:invite")');
    expect(src).toContain("canInviteMembers");
    expect(src).toMatch(
      /canInvite\s*=\s*[\s\S]*?hasPermission\("members:invite"\)\s*&&\s*canInviteMembers\(\s*org\s*\)/,
    );
    expect(src).toMatch(/\{canInvite && \(/);
    expect(src).toContain("InvitePanel");
    expect(src).toContain("refreshKey={inviteRefreshKey}");
  });

  it("personal path is upgrade EmptyState only — no invite spam", () => {
    expect(src).toContain("data-ws2-personal-members");
    expect(src).toContain("Create a team workspace");
    expect(src).toMatch(/if\s*\(\s*isPersonal\s*\)\s*\{/);
    expect(src).toContain("EmptyState");
    // Invite form / pending panel must stay behind canInvite (team + perm).
    const personalBlock = src.slice(
      src.indexOf("if (isPersonal)"),
      src.indexOf("type Member"),
    );
    expect(personalBlock).not.toContain("Invite member");
    expect(personalBlock).not.toContain("<InvitePanel");
  });

  it("remove requires members:remove; destructive confirm uses kit Dialog", () => {
    expect(src).toContain('hasPermission("members:remove")');
    expect(src).toMatch(/canRemove\s*&&\s*m\.role\s*!==\s*"owner"/);
    expect(src).toContain("useConfirm");
    expect(src).toContain("ConfirmDialog");
    expect(src).toContain('from "@/components/ui/button"');
  });

  it("orgless empty uses workspace copy", () => {
    expect(src).toContain("Select or create a workspace to manage members");
    expect(src).toContain("Open Workspace settings");
  });

  it("does not invent Roles product surface", () => {
    expect(src).not.toMatch(/RolesTab|roles product|custom roles/i);
    expect(src).not.toContain('href="/settings?tab=roles"');
  });
});

describe("WS4 Members — invite-panel", () => {
  const src = read("app/(portal)/settings/_components/invite-panel.tsx");

  it("uses kit Button + SettingsCard; returns null when !canManage", () => {
    expect(src).toContain('from "@/components/ui/button"');
    expect(src).toContain("SettingsCard");
    expect(src).toContain("useConfirm");
    expect(src).toMatch(/if\s*\(\s*!canManage\s*\)\s*return\s*null/);
    expect(src).toContain("refreshKey");
    expect(src).not.toMatch(/from\s+"@\/components\/ui\/card"/);
  });
});

describe("WS4 Security — placeholder for peer", () => {
  it.todo("security-tab kit Switch + workspace 2FA enforcement copy");
});
