/**
 * Wave 2.2 invite-flow-ux — accept → setActive, org-list gate, degraded
 * clerk_org_id path (no silent wrong-org redirect).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = resolve(__dirname, "../page.tsx");

function read(): string {
  return readFileSync(page, "utf8");
}

describe("invite-flow-ux accept → setActive", () => {
  it("activates clerk_org_id via setActive before dashboard redirect", () => {
    const src = read();
    expect(src).toContain("useOrganizationList");
    expect(src).toContain("setActiveOrg");
    expect(src).toMatch(/setActiveOrg\(\{\s*organization:\s*accepted\.clerk_org_id\s*\}\)/);
    expect(src).toContain('router.push("/dashboard")');
  });

  it("blocks accept until organization list is loaded", () => {
    const src = read();
    expect(src).toContain("orgListLoaded");
    expect(src).toContain("acceptBlockedByOrgList");
    expect(src).toMatch(/disabled=\{acceptBlockedByOrgList\}/);
    expect(src).toContain("Organization switcher is still loading");
  });

  it("surfaces degraded join when clerk_org_id is missing", () => {
    const src = read();
    expect(src).toContain("joinedDegraded");
    expect(src).toContain("Workspace activation delayed");
    expect(src).toContain("organization switcher");
    // Must not silently router.push when clerk_org_id is absent.
    const acceptFn = src.slice(
      src.indexOf("const handleAccept"),
      src.indexOf("const sessionReady"),
    );
    expect(acceptFn).toContain("setJoinedDegraded");
    const pushCount = (acceptFn.match(/router\.push/g) ?? []).length;
    expect(pushCount).toBe(1);
    expect(acceptFn).toMatch(/if \(accepted\.clerk_org_id\)/);
  });

  it("shows invited role on the accept confirmation copy", () => {
    const src = read();
    expect(src).toContain("inviteData.role");
    expect(src).toContain("as{\" \"}");
    expect(src).toContain("<strong>{inviteData.role}</strong>");
  });
});
