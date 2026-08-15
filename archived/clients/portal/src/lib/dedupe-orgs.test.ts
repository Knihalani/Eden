/**
 * Tests for the display-level workspace dedupe (legacy Clerk session-task
 * remint duplicates — seven same-named orgs, one live Clerk link).
 */
import { describe, expect, it } from "vitest";
import { dedupeOrganizations } from "@/lib/dedupe-orgs";
import type { Organization } from "@/lib/types";

function org(partial: Partial<Organization> & { id: string }): Organization {
  return {
    name: "Kaiav's Organization",
    slug: partial.id,
    role: "owner",
    is_owner: true,
    clerk_org_id: null,
    ...partial,
  };
}

describe("dedupeOrganizations", () => {
  it("collapses seven same-named orgs to the one with a live Clerk membership", () => {
    const dupes = [
      org({ id: "e1" }),
      org({ id: "e2", clerk_org_id: "org_dead1" }),
      org({ id: "e3", clerk_org_id: "org_live" }),
      org({ id: "e4" }),
      org({ id: "e5", clerk_org_id: "org_dead2" }),
      org({ id: "e6" }),
      org({ id: "e7" }),
    ];
    const out = dedupeOrganizations(dupes, {
      clerkMembershipIds: new Set(["org_live"]),
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("e3");
  });

  it("keeps orgs with different names untouched and preserves order", () => {
    const list = [
      org({ id: "a", name: "Alpha" }),
      org({ id: "b", name: "Beta" }),
      org({ id: "c", name: "gamma" }),
    ];
    const out = dedupeOrganizations(list);
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("matches names case-insensitively and ignores surrounding whitespace", () => {
    const list = [
      org({ id: "a", name: "My Workspace" }),
      org({ id: "b", name: "  my workspace " }),
    ];
    expect(dedupeOrganizations(list)).toHaveLength(1);
  });

  it("never merges orgs with empty names", () => {
    const list = [org({ id: "a", name: "" }), org({ id: "b", name: "  " })];
    expect(dedupeOrganizations(list)).toHaveLength(2);
  });

  it("prefers the current org over a Clerk-linked duplicate", () => {
    const list = [
      org({ id: "linked", clerk_org_id: "org_live" }),
      org({ id: "current" }),
    ];
    const out = dedupeOrganizations(list, {
      currentOrgId: "current",
      clerkMembershipIds: new Set(["org_live"]),
    });
    expect(out[0].id).toBe("current");
  });

  it("falls back to a Clerk-linked org when no membership info is available", () => {
    const list = [org({ id: "eden-only" }), org({ id: "linked", clerk_org_id: "org_x" })];
    const out = dedupeOrganizations(list);
    expect(out[0].id).toBe("linked");
  });

  it("keeps the newest org when duplicates are indistinguishable", () => {
    // /auth/me orders newest first; ties must keep input order.
    const list = [org({ id: "newer" }), org({ id: "older" })];
    const out = dedupeOrganizations(list);
    expect(out[0].id).toBe("newer");
  });

  it("survivor order follows first appearance of each name group", () => {
    const list = [
      org({ id: "b1", name: "Beta" }),
      org({ id: "a1", name: "Alpha" }),
      org({ id: "b2", name: "Beta" }),
    ];
    const out = dedupeOrganizations(list);
    expect(out.map((o) => o.name)).toEqual(["Beta", "Alpha"]);
  });

  it("handles an empty list", () => {
    expect(dedupeOrganizations([])).toEqual([]);
  });
});
