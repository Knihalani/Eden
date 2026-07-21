/**
 * Wave 9 — Settings + Workspace exit criteria.
 * ≤8 default tabs; no 240px double sidebar; Advanced holds gateway/PII/retention/exports;
 * ghosts soft-hidden; AccountPanel inline; search token match.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 9 settings IA exit", () => {
  const page = read("app/(portal)/settings/page.tsx");
  // Wave 1 extracts IA into registry; page re-exports / imports markers.
  const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
  const ia = registry.includes("TABS:") || registry.includes("export const TABS")
    ? registry
    : page;

  it("marks wave9-settings completed", () => {
    expect(ia).toContain("WAVE9_SETTINGS_COMPLETED = true");
    expect(page).toContain("WAVE9_SETTINGS_COMPLETED");
    expect(page).toContain("data-wave9-settings");
  });

  it("keeps 5 settings categories (Compliance lives on /audit-trail)", () => {
    for (const cat of ["Org", "Members", "Security", "Billing", "Advanced"]) {
      expect(ia).toContain(`"${cat}"`);
    }
    expect(ia).not.toContain('"Compliance"');
    expect(page).toContain("CATEGORY_ORDER");
  });

  it("defaults to ≤6 visible tabs", () => {
    const defaults = [...ia.matchAll(/defaultVisible:\s*true/g)];
    expect(defaults.length).toBeLessThanOrEqual(6);
    expect(defaults.length).toBeGreaterThanOrEqual(5);
    for (const id of ["account", "api-keys", "members", "security", "billing"]) {
      expect(ia).toContain(`id: "${id}"`);
    }
    // Home slot: overview (Wave 1) or org (pre-overview).
    expect(ia.includes('id: "overview"') || ia.includes('id: "org"')).toBe(true);
    expect(ia).toContain("DEFAULT_VISIBLE_TAB_IDS");
    expect(ia).toContain("WAVE9_DAILY_TAB_CAP");
  });

  it("moves gateway / retention / PII / exports into Advanced", () => {
    for (const id of ["gateway", "pii", "retention", "exports"]) {
      const block = ia.slice(ia.indexOf(`id: "${id}"`), ia.indexOf(`id: "${id}"`) + 280);
      expect(block).toContain('category: "Advanced"');
      expect(block).not.toContain("defaultVisible: true");
    }
  });

  it("soft-hides roles/sso ghosts (not in TABS)", () => {
    expect(ia).not.toMatch(/id:\s*"roles"/);
    expect(ia).not.toMatch(/id:\s*"sso"/);
    expect(page).toContain("GHOST_TABS");
    expect(ia).toContain("GHOST_TABS");
    expect(ia).toContain('"roles"');
    expect(ia).toContain('"sso"');
  });

  it("kills the 240px double sidebar in favor of category pills", () => {
    expect(page).not.toContain("lg:w-[240px]");
    expect(page).not.toContain("w-[240px]");
    expect(page).toContain('variant="pills"');
    expect(page).toContain("TabsList");
    expect(page).toContain('from "@/components/ui/tabs"');
  });

  it("uses inline AccountPanel (not embedded profile page)", () => {
    expect(page).toContain("account-panel");
    expect(page).not.toContain('import("@/app/(portal)/profile/page")');
    expect(page).not.toContain("EmbeddedSurface");
    const panel = read("app/(portal)/settings/_components/account-panel.tsx");
    expect(panel).toContain("export function AccountPanel");
    expect(panel).not.toMatch(/from ["']@\/components\/layout\/page-header["']/);
    expect(panel).not.toMatch(/from ["']@\/components\/layout\/page-content["']/);
  });

  it("tokenizes settings search (AND match)", () => {
    expect(page).toContain("tabMatchesQuery");
    expect(ia).toContain("tokens.every");
    expect(ia).toContain("split(/\\s+/)");
  });
});

describe("Wave 9 polish surfaces", () => {
  it("members puts invite + pending before the table", () => {
    const src = read("app/(portal)/settings/_components/members-tab.tsx");
    const inviteIdx = src.indexOf("Invite member");
    const invitePanelIdx = src.indexOf("<InvitePanel");
    const membersTableIdx = src.indexOf('title="Members"');
    expect(inviteIdx).toBeGreaterThan(-1);
    expect(invitePanelIdx).toBeGreaterThan(inviteIdx);
    expect(membersTableIdx).toBeGreaterThan(invitePanelIdx);
    expect(src).not.toContain('header: "Joined"');
    expect(src).not.toContain('header: "Last Active"');
  });

  it("api-keys create card precedes SDK credentials", () => {
    const src = read("app/(portal)/settings/_components/api-keys-tab.tsx");
    const createIdx = src.indexOf("ApiKeysCreatePanel");
    const sdkIdx = src.indexOf("ApiKeysSdkCredentials");
    expect(createIdx).toBeGreaterThan(-1);
    expect(sdkIdx).toBeGreaterThan(createIdx);
    const create = read(
      "app/(portal)/settings/_components/api-keys-create-panel.tsx",
    );
    expect(create).toContain('title="Create API key"');
  });

  it("billing uses calm plan summary (no 4xl spend)", () => {
    const src = read("app/(portal)/settings/_components/billing-tab.tsx");
    expect(src).toContain("text-2xl font-semibold");
    expect(src).not.toContain("text-4xl font-bold");
    expect(src).toContain("Plan limits");
    expect(src).not.toContain("rounded-full text-sm font-medium");
  });

  it("audit log decluttered (no action pills / metadata column)", () => {
    const stub = read("app/(portal)/settings/_components/audit-log-tab.tsx");
    expect(stub).toContain("data-ws6-audit-stub");
    const src = read("app/(portal)/audit-trail/_components/events-panel.tsx");
    expect(src).not.toContain("actionPill");
    expect(src).not.toContain('header: "Details"');
    expect(src).toContain("PermissionGate");
  });

  it("permission gate uses human microcopy", () => {
    const src = read("components/settings/permission-gate.tsx");
    expect(src).toContain("You need an admin to open this");
    expect(src).toContain("humanLabel");
    expect(src).not.toContain("You don&apos;t have access to this section");
  });

  it("audit trail header is quieter", () => {
    const src = read("app/(portal)/audit-trail/page.tsx");
    expect(src).toContain("Chain-verified agent events");
    expect(src).not.toMatch(/description="Export SOC2/);
    expect(src).not.toMatch(/Verify chain<\/Button>/);
  });
});
