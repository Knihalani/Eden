/**
 * Wave 3 — Org + Account leaf exit markers (M14 / C3).
 * Source-level: data-ws3-org / data-ws3-account, WS3_*_COMPLETED, kit surfaces.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS3 Org identity leaf", () => {
  const orgTab = read("app/(portal)/settings/_components/org-tab.tsx");
  const helpers = read("app/(portal)/settings/_components/org-tab-helpers.ts");
  const deleteDialog = read("app/(portal)/settings/_components/delete-org-dialog.tsx");
  const transferDialog = read(
    "app/(portal)/settings/_components/transfer-ownership-dialog.tsx",
  );

  it("exports WS3_ORG_COMPLETED and data-ws3-org root marker", () => {
    expect(orgTab).toContain("export const WS3_ORG_COMPLETED = true");
    expect(orgTab).toContain('data-ws3-org="true"');
  });

  it("uses kit SettingsCard, DangerZone, Dialog, and Button only", () => {
    expect(orgTab).toContain('from "@/components/settings/settings-card"');
    expect(orgTab).toContain('from "@/components/settings/danger-zone"');
    expect(orgTab).toContain("<SettingsCard");
    expect(orgTab).toContain("<DangerZone");
    expect(orgTab).toContain('from "@/components/ui/button"');
    expect(orgTab).not.toMatch(/bg-\[var\(--accent\)\].*rounded.*onClick/);
    expect(deleteDialog).toContain('from "@/components/ui/dialog"');
    expect(deleteDialog).toContain('from "@/components/ui/button"');
    expect(transferDialog).toContain('from "@/components/ui/dialog"');
    expect(transferDialog).toContain('variant="destructive"');
  });

  it("supports name/slug edit and peels helpers", () => {
    expect(orgTab).toContain("handleSaveIdentity");
    expect(orgTab).toContain("normalizeSlug");
    expect(orgTab).toContain('from "./org-tab-helpers"');
    expect(helpers).toContain("export function normalizeSlug");
    expect(helpers).toContain("export function dangerZoneDescription");
  });

  it("hides transfer for personal and uses workspace copy", () => {
    expect(orgTab).toContain("isPersonal");
    expect(orgTab).toMatch(/!isPersonal &&/);
    expect(orgTab).toContain("Workspace details");
    expect(orgTab).toContain("Create workspace");
    expect(orgTab).toContain("dangerZoneDescription(isPersonal)");
    expect(helpers).toMatch(/personal workspace/i);
    expect(orgTab).not.toContain("Rename not available in portal yet");
  });
});

describe("WS3 Account leaf", () => {
  const panel = read("app/(portal)/settings/_components/account-panel.tsx");
  const sections = read("app/(portal)/settings/_components/account-panel-sections.tsx");
  const disable2fa = read("app/(portal)/settings/_components/disable-2fa-dialog.tsx");

  it("exports WS3_ACCOUNT_COMPLETED and data-ws3-account", () => {
    expect(panel).toContain("export const WS3_ACCOUNT_COMPLETED = true");
    expect(panel).toContain('data-ws3-account="true"');
  });

  it("uses SettingsCard + DangerZone + kit Button (no hand-rolled modal shell)", () => {
    expect(panel).toContain("DangerZone");
    expect(panel).toContain('from "@/components/ui/button"');
    expect(sections).toContain("SettingsCard");
    expect(panel).not.toContain('from "@/components/ui/card"');
    expect(panel).not.toMatch(/fixed inset-0 bg-\[var\(--overlay\)\]/);
    expect(panel).not.toMatch(/<button\b/);
    expect(sections).not.toMatch(/<button\b/);
  });

  it("gates disable-2FA with kit Dialog", () => {
    expect(disable2fa).toContain('from "@/components/ui/dialog"');
    expect(disable2fa).toContain("DialogContent");
    expect(disable2fa).toContain('variant="destructive"');
    expect(panel).toContain("Disable2FADialog");
  });

  it("keeps personal (me) scope copy clear of workspace/org identity", () => {
    expect(panel).toMatch(/Personal profile only|personal account/i);
    expect(sections).toContain("Your profile");
    expect(sections).toContain("Personal account details");
  });

  it("account-panel shell stays under 400 LOC", () => {
    expect(panel.split("\n").length).toBeLessThanOrEqual(400);
  });
});
