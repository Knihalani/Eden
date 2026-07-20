/**
 * W6-1 — Settings org / members / API keys / MCP keys:
 * - admin gates use resolveRole (via usePermissions / isAdminOrOwner)
 * - personal-org soft-hide SCIM / SSO / transfer
 * - create-org degraded path helpers
 * - members remove gated on members:remove (not bare non-owner)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATE_ORG_DEGRADED_DESCRIPTION,
  CREATE_ORG_DEGRADED_TITLE,
  isCreateOrgDegraded,
  organizationFromCreate,
} from "@/lib/create-org";
import { isAdminOrOwner, isOwnerRole } from "@/lib/roles";
import { resolveRole } from "@/hooks/use-permissions";

// __dirname = …/settings/__tests__ → portal src root is 4 levels up.
const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6-1 admin gates use resolveRole", () => {
  it("api-keys-tab gates create/revoke with resolveRole + isAdminOrOwner", () => {
    const src = read("app/(portal)/settings/_components/api-keys-tab.tsx");
    expect(src).toContain("usePermissions");
    expect(src).toContain("isAdminOrOwner(resolvedRole)");
    expect(src).toMatch(/const canManage\s*=/);
  });

  it("mcp-tab gates Create MCP key with resolveRole + isAdminOrOwner", () => {
    const src = read("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(src).toContain("usePermissions");
    expect(src).toContain("isAdminOrOwner(resolvedRole)");
    expect(src).toContain("canManageKeys");
    expect(src).toMatch(/if\s*\(\s*!org\s*\|\|\s*!canManageKeys\s*\)\s*return/);
  });

  it("org-tab archive/danger zone uses resolveRole for admin/owner", () => {
    const src = read("app/(portal)/settings/_components/org-tab.tsx");
    expect(src).toContain("usePermissions");
    expect(src).toContain("isAdminOrOwner(resolvedRole)");
    expect(src).toContain("isOwnerRole(resolvedRole)");
  });

  it("settings page admin tabs require settings:edit (resolveRole-backed)", () => {
    const src = read("app/(portal)/settings/page.tsx");
    expect(src).toContain('hasPermission("settings:edit")');
    expect(src).toMatch(/api-keys.*canEditSettings|canEditSettings && <ApiKeysTab/);
    expect(src).toContain("canEditSettings && <ApiKeysTab");
  });

  it("resolveRole unlocks admin during Clerk sync lag (creator)", () => {
    const role = resolveRole(null, "org:admin");
    expect(isAdminOrOwner(role)).toBe(true);
    expect(isOwnerRole(role)).toBe(true);
  });
});

describe("W6-1 personal-org soft-hide SCIM/SSO/transfer", () => {
  it("settings page soft-hides SCIM and SSO for personal orgs", () => {
    const src = read("app/(portal)/settings/page.tsx");
    expect(src).toMatch(/isPersonalOrg && \(id === "scim" \|\| id === "sso"\)/);
    expect(src).toContain("Team organizations only");
  });

  it("org-tab and transfer section soft-hide transfer for personal orgs", () => {
    const orgTab = read("app/(portal)/settings/_components/org-tab.tsx");
    expect(orgTab).toContain("isPersonal");
    expect(orgTab).toMatch(/!isPersonal &&/);
    const transfer = read(
      "app/(portal)/settings/_components/transfer-ownership-section.tsx",
    );
    expect(transfer).toMatch(/if\s*\(\s*org\.is_personal\s*\)\s*return\s*null/);
  });

  it("members tab blocks invites on personal orgs", () => {
    const src = read("app/(portal)/settings/_components/members-tab.tsx");
    expect(src).toMatch(
      /canInvite\s*=\s*hasPermission\("members:invite"\)\s*&&\s*!isPersonal/,
    );
  });
});

describe("W6-1 members remove permission gate", () => {
  it("members-tab requires members:remove for trash control", () => {
    const src = read("app/(portal)/settings/_components/members-tab.tsx");
    expect(src).toContain('hasPermission("members:remove")');
    expect(src).toMatch(/canRemove\s*&&\s*m\.role\s*!==\s*"owner"/);
  });

  it("members-settings requires members:remove for trash control", () => {
    const src = read("app/(portal)/settings/_components/members-settings.tsx");
    expect(src).toContain('hasPermission("members:remove")');
    expect(src).toMatch(/canRemove\s*&&\s*m\.role\s*!==\s*"owner"/);
  });
});

describe("W6-1 create-org degraded path", () => {
  it("organizationFromCreate keeps owner + is_personal for setCurrentOrg", () => {
    const org = organizationFromCreate({
      org_id: "eden-1",
      name: "Solo",
      slug: "solo",
      role: "owner",
      clerk_org_id: null,
      org_degraded: true,
      is_personal: true,
    });
    expect(isCreateOrgDegraded({
      org_id: "eden-1",
      name: "Solo",
      slug: "solo",
      role: "owner",
      clerk_org_id: null,
      org_degraded: true,
    })).toBe(true);
    expect(org.role).toBe("owner");
    expect(org.is_owner).toBe(true);
    expect(org.is_personal).toBe(true);
    expect(isAdminOrOwner(resolveRole(org, null))).toBe(true);
    expect(CREATE_ORG_DEGRADED_TITLE.length).toBeGreaterThan(0);
    expect(CREATE_ORG_DEGRADED_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it("org-tab wires degraded toast + setCurrentOrg(organizationFromCreate)", () => {
    const src = read("app/(portal)/settings/_components/org-tab.tsx");
    expect(src).toContain("isCreateOrgDegraded");
    expect(src).toContain("organizationFromCreate");
    expect(src).toContain("CREATE_ORG_DEGRADED_TITLE");
    expect(src).toContain("setCurrentOrg(organizationFromCreate(created))");
  });
});
