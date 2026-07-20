// @vitest-environment node
/**
 * W4-A / W4-D — Settings / org UX helpers: create-org Clerk activation +
 * owner/admin role gates (must not exclude owners or admins wrongly).
 */
import { describe, expect, it } from "vitest";
import {
  CREATE_ORG_DEGRADED_TITLE,
  clerkOrgIdToActivate,
  isCreateOrgDegraded,
  organizationFromCreate,
} from "@/lib/create-org";
import { isAdminOrOwner, isOwnerRole } from "@/lib/roles";
import { resolveRole } from "@/hooks/use-permissions";
import { isOrgSyncing } from "@/lib/org-syncing";

describe("W4-A create-org Clerk activation", () => {
  it("activates when clerk_org_id is present", () => {
    expect(
      clerkOrgIdToActivate({
        org_id: "eden-1",
        name: "Acme",
        slug: "acme",
        role: "owner",
        clerk_org_id: "org_abc",
        org_degraded: false,
      }),
    ).toBe("org_abc");
    expect(
      isCreateOrgDegraded({
        org_id: "eden-1",
        name: "Acme",
        slug: "acme",
        role: "owner",
        clerk_org_id: "org_abc",
        org_degraded: false,
      }),
    ).toBe(false);
  });

  it("skips setActive and flags degraded when clerk_org_id is null", () => {
    expect(
      clerkOrgIdToActivate({
        org_id: "eden-1",
        name: "Acme",
        slug: "acme",
        role: "owner",
        clerk_org_id: null,
        org_degraded: true,
      }),
    ).toBeNull();
    expect(
      isCreateOrgDegraded({
        org_id: "eden-1",
        name: "Acme",
        slug: "acme",
        role: "owner",
        clerk_org_id: null,
        org_degraded: true,
      }),
    ).toBe(true);
    expect(CREATE_ORG_DEGRADED_TITLE.length).toBeGreaterThan(0);
  });

  it("treats missing clerk_org_id as degraded even without the flag", () => {
    expect(
      isCreateOrgDegraded({
        org_id: "eden-1",
        name: "Acme",
        slug: "acme",
        role: "owner",
        clerk_org_id: null,
      }),
    ).toBe(true);
    expect(
      clerkOrgIdToActivate({
        org_id: "eden-1",
        name: "Acme",
        slug: "acme",
        role: "owner",
        clerk_org_id: null,
      }),
    ).toBeNull();
  });

  it("organizationFromCreate keeps owner so setCurrentOrg does not leave non-admin", () => {
    const org = organizationFromCreate({
      org_id: "eden-uuid",
      name: "Solo Co",
      slug: "solo-co",
      role: "owner",
      clerk_org_id: null,
      org_degraded: true,
    });
    expect(org.id).toBe("eden-uuid");
    expect(org.role).toBe("owner");
    expect(org.is_owner).toBe(true);
    expect(org.clerk_org_id).toBeNull();
    expect(isAdminOrOwner(org.role)).toBe(true);
    expect(isOwnerRole(org.role)).toBe(true);
  });
});

describe("W4-D owner/admin gates", () => {
  it("isAdminOrOwner accepts both owner and admin", () => {
    expect(isAdminOrOwner("owner")).toBe(true);
    expect(isAdminOrOwner("admin")).toBe(true);
    expect(isAdminOrOwner("member")).toBe(false);
    expect(isAdminOrOwner(null)).toBe(false);
  });

  it("isOwnerRole is owner-only (transfer/delete)", () => {
    expect(isOwnerRole("owner")).toBe(true);
    expect(isOwnerRole("admin")).toBe(false);
  });

  it("resolveRole owner during Clerk sync lag unlocks admin gates", () => {
    const role = resolveRole(null, "org:admin");
    expect(isAdminOrOwner(role)).toBe(true);
    expect(isOwnerRole(role)).toBe(true);
  });

  it("resolveRole admin still passes admin gates", () => {
    const role = resolveRole({ role: "admin" }, "org:member");
    expect(isAdminOrOwner(role)).toBe(true);
    expect(isOwnerRole(role)).toBe(false);
  });
});

describe("orgSyncing / Eden-only selection", () => {
  it("does not spin when Eden-only org is selected while Clerk has another org", () => {
    expect(
      isOrgSyncing({
        clerkOrgId: "org_previous",
        currentOrg: { id: "eden-uuid", clerk_org_id: null },
        authErrorKind: null,
        loading: false,
        meInFlight: false,
      }),
    ).toBe(false);
  });

  it("still syncs when Clerk org is active but Eden currentOrg is null", () => {
    expect(
      isOrgSyncing({
        clerkOrgId: "org_new",
        currentOrg: null,
        authErrorKind: null,
        loading: false,
        meInFlight: false,
      }),
    ).toBe(true);
  });

  it("still syncs on clerk_org_id mismatch for mapped Eden rows", () => {
    expect(
      isOrgSyncing({
        clerkOrgId: "org_new",
        currentOrg: { id: "eden-uuid", clerk_org_id: "org_old" },
        authErrorKind: null,
        loading: false,
        meInFlight: false,
      }),
    ).toBe(true);
  });
});
