/**
 * Wave 10 — orgless / invite workspace copy contracts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");
function read(rel: string) {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS10 a11y / orgless contracts", () => {
  it("NoOrgState teaches workspace wording", () => {
    const noOrg = read("components/ui/no-org-state.tsx");
    expect(noOrg.toLowerCase()).toMatch(/workspace/);
  });

  it("settings shell has accessible tab semantics", () => {
    const page = read("app/(portal)/settings/page.tsx");
    expect(page).toContain('role="tablist"');
    expect(page).toContain("role=\"tabpanel\"");
    expect(page).toContain('role="status"');
  });

  it("audit trail has segment aria label", () => {
    const audit = read("app/(portal)/audit-trail/page.tsx");
    expect(audit).toContain('aria-label="Audit trail segments"');
  });
});
