/**
 * Wave 2 — Workspace overview composition markers + personal CTA path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS2 Workspace overview composition", () => {
  const overview = read("app/(portal)/settings/_components/overview-panel.tsx");

  it("exports WS2 marker and data-ws2-overview root", () => {
    expect(overview).toContain("WS2_OVERVIEW_COMPLETED");
    expect(overview).toContain("data-ws2-overview");
  });

  it("personal primary CTA uses create-team path strings", () => {
    expect(overview).toContain("/settings?tab=org&create=1");
    expect(overview).toContain("Create a team workspace");
    expect(overview).toContain('"create-team"');
  });

  it("team primary CTA targets API keys; secondary quiet links exist", () => {
    expect(overview).toContain("/settings?tab=api-keys");
    expect(overview).toContain("Manage API keys");
    expect(overview).toContain("/settings?tab=members");
    expect(overview).toContain("/settings?tab=billing");
    expect(overview).toContain("/audit-trail?segment=events");
  });

  it("does not invent Roles or SSO product chrome", () => {
    expect(overview).not.toMatch(/\bSSO\b/);
    expect(overview).not.toMatch(/\bRoles\b/);
    expect(overview).not.toContain("?tab=sso");
    expect(overview).not.toContain("?tab=roles");
  });
});
