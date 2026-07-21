/**
 * Wave 6 — unified audit trail contracts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");
function read(rel: string) {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS6 unified audit trail", () => {
  const page = read("app/(portal)/audit-trail/page.tsx");
  const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
  const settingsPage = read("app/(portal)/settings/page.tsx");

  it("exports WS6_AUDIT_COMPLETED and segment UI", () => {
    expect(page).toContain("WS6_AUDIT_COMPLETED");
    expect(page).toContain("data-ws6-audit");
    expect(page).toContain("data-ws6-segments");
    expect(page).toContain("EventsPanel");
    expect(page).toContain("ChainPanel");
  });

  it("settings audit-log redirects to /audit-trail", () => {
    expect(registry).toContain('SETTINGS_AUDIT_LOG_REDIRECT_HREF = "/audit-trail"');
    expect(settingsPage).toContain('urlTabParam === "audit-log"');
    expect(settingsPage).not.toMatch(/import\(.*audit-log-tab/);
  });
});
