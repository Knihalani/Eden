// @vitest-environment node
/**
 * W2-D — Portal role mapping alignment with backend
 * ``clerk_role_to_eden_role``: org creators keep owner perms during
 * Clerk ↔ Eden sync lag. Wave 1.4 solo-org-admin: Eden DB owner wins
 * over weaker Clerk JWT; degraded create keeps owner UX.
 */
import { describe, expect, it } from "vitest";
import { clerkRoleToEden, hasEdenRole, isAdminOrOwner, isOwnerRole } from "@/lib/roles";
import { resolveRole } from "@/hooks/use-permissions";
import {
  isCreateOrgDegraded,
  organizationFromCreate,
} from "@/lib/create-org";

describe("W2-D clerkRoleToEden", () => {
  it("maps org:admin and admin to owner (match backend)", () => {
    expect(clerkRoleToEden("org:admin")).toBe("owner");
    expect(clerkRoleToEden("admin")).toBe("owner");
  });

  it("maps org:member and member to member", () => {
    expect(clerkRoleToEden("org:member")).toBe("member");
    expect(clerkRoleToEden("member")).toBe("member");
  });

  it("maps null/empty to viewer and custom org roles to admin", () => {
    expect(clerkRoleToEden(null)).toBe("viewer");
    expect(clerkRoleToEden(undefined)).toBe("viewer");
    expect(clerkRoleToEden("")).toBe("viewer");
    expect(clerkRoleToEden("org:billing")).toBe("admin");
  });

  it("grants owner-rank checks for Clerk org:admin", () => {
    expect(hasEdenRole("org:admin", "owner")).toBe(true);
    expect(hasEdenRole("org:admin", "admin")).toBe(true);
    expect(hasEdenRole("org:member", "owner")).toBe(false);
  });
});

describe("W2-D resolveRole creator fallback", () => {
  it("prefers Eden DB role from /auth/me when present", () => {
    expect(resolveRole({ role: "admin" }, "org:admin")).toBe("admin");
    expect(resolveRole({ role: "member" }, "org:admin")).toBe("member");
    expect(resolveRole({ role: "owner" }, "org:member")).toBe("owner");
  });

  it("falls back to owner via Clerk org:admin when Eden role is missing", () => {
    expect(resolveRole(null, "org:admin")).toBe("owner");
    expect(resolveRole({}, "org:admin")).toBe("owner");
    expect(resolveRole({ role: undefined }, "admin")).toBe("owner");
  });

  it("keeps org:transfer / billing / GDPR for creator during sync lag", () => {
    const role = resolveRole(null, "org:admin");
    expect(role).toBe("owner");
    // usePermissions builds from PERMISSION_MAP[role]; assert owner
    // is what unlocks creator-only actions during lag.
    expect(role).not.toBe("admin");
  });

  it("uses is_owner before Clerk map when Eden role absent", () => {
    expect(resolveRole({ is_owner: true }, "org:member")).toBe("owner");
  });

  it("JWT/Clerk member cannot demote Eden DB owner (solo creator)", () => {
    expect(resolveRole({ role: "owner" }, "org:member")).toBe("owner");
    expect(resolveRole({ role: "owner" }, "member")).toBe("owner");
    expect(resolveRole({ role: "owner", is_owner: true }, null)).toBe("owner");
    expect(isOwnerRole(resolveRole({ role: "owner" }, "org:member"))).toBe(true);
    expect(isAdminOrOwner(resolveRole({ role: "owner" }, "org:member"))).toBe(true);
  });
});

describe("W2-D / W1.4 degraded create keeps owner UX", () => {
  it("organizationFromCreate forces owner + is_owner when Clerk degraded", () => {
    const org = organizationFromCreate({
      org_id: "eden-solo",
      name: "Solo Dev",
      slug: "solo-dev",
      role: "owner",
      clerk_org_id: null,
      org_degraded: true,
      is_personal: true,
    });
    expect(isCreateOrgDegraded({
      org_id: "eden-solo",
      name: "Solo Dev",
      slug: "solo-dev",
      role: "owner",
      clerk_org_id: null,
      org_degraded: true,
    })).toBe(true);
    expect(org.role).toBe("owner");
    expect(org.is_owner).toBe(true);
    expect(org.is_personal).toBe(true);
    expect(resolveRole(org, null)).toBe("owner");
    expect(isAdminOrOwner(resolveRole(org, "org:member"))).toBe(true);
  });

  it("organizationFromCreate defaults missing role to owner", () => {
    const org = organizationFromCreate({
      org_id: "eden-2",
      name: "X",
      slug: "x",
      role: "",
      clerk_org_id: null,
    });
    expect(org.role).toBe("owner");
    expect(org.is_owner).toBe(true);
  });
});
