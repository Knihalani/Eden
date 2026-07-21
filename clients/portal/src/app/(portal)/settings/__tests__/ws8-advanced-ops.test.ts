/**
 * Wave 8 — Advanced integrations + ops (M5, M7, S15–S16, S23–S24).
 * Source-level asserts: SCIM personal gate, *-settings re-exports, data-ws8 markers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS8 advanced ops — SCIM personal gate (M5 / S16)", () => {
  const scim = read("app/(portal)/settings/_components/scim-tab.tsx");
  const mode = read("lib/workspace-mode.ts");
  const page = read("app/(portal)/settings/page.tsx");

  it("scim-tab uses workspace-mode helpers and personal empty state", () => {
    expect(scim).toContain("isPersonalWorkspace");
    expect(scim).toContain("canUseTeamFeatures");
    expect(scim).toContain('from "@/lib/workspace-mode"');
    expect(scim).toContain('data-ws8-scim-personal="true"');
    expect(scim).toContain("SCIM needs a team workspace");
    expect(scim).not.toMatch(/Contact your organization admin/);
  });

  it("hub + workspace-mode keep SCIM team-only", () => {
    expect(mode).toContain('teamOnlyTabs = ["scim"]');
    expect(mode).toContain("isTeamOnlyTab");
    expect(page).toContain("isTeamOnlyTab");
    expect(page).toContain("isPersonalWorkspace");
  });
});

describe("WS8 advanced ops — S15 settings→tab dedupe", () => {
  it("org/members/api-keys settings re-export canonical tabs", () => {
    const org = read("app/(portal)/settings/_components/org-settings.tsx");
    const members = read("app/(portal)/settings/_components/members-settings.tsx");
    const keys = read("app/(portal)/settings/_components/api-keys-settings.tsx");

    expect(org).toContain('from "./org-tab"');
    expect(org).toContain("OrgTab as OrgSettings");
    expect(org).not.toContain("export function OrgSettings");

    expect(members).toContain('from "./members-tab"');
    expect(members).toContain("MembersTab as MembersSettings");
    expect(members).not.toContain("export function MembersSettings");

    expect(keys).toContain('from "./api-keys-tab"');
    expect(keys).toContain("ApiKeysTab as ApiKeysSettings");
    expect(keys).not.toContain("export function ApiKeysSettings");
  });
});

describe("WS8 advanced ops — markers + kit CTAs (M7 / S23)", () => {
  it("owned tabs carry data-ws8-* and WS8_ADVANCED_OPS_COMPLETED", () => {
    const scim = read("app/(portal)/settings/_components/scim-tab.tsx");
    expect(scim).toContain("WS8_ADVANCED_OPS_COMPLETED");
    expect(scim).toContain("data-ws8-scim");

    expect(read("app/(portal)/settings/_components/mcp-tab.tsx")).toContain("data-ws8-mcp");
    expect(read("app/(portal)/settings/_components/references-tab.tsx")).toContain(
      "data-ws8-references",
    );
    expect(read("app/(portal)/settings/_components/analytics-tab.tsx")).toContain(
      "data-ws8-analytics",
    );
    expect(read("app/(portal)/settings/_components/finops-kills-tab.tsx")).toContain(
      "data-ws8-finops",
    );
    expect(read("app/(portal)/settings/_components/autonomous-tab.tsx")).toContain(
      "data-ws8-autonomous",
    );
    expect(read("app/(portal)/settings/_components/status-tab.tsx")).toContain(
      "data-ws8-status",
    );
    expect(read("app/(portal)/settings/_components/sidebar-settings-tab.tsx")).toContain(
      "data-ws8-sidebar",
    );
  });

  it("touched CTAs use kit Button (scim rotate/copy, mcp targets, references delete)", () => {
    const scim = read("app/(portal)/settings/_components/scim-tab.tsx");
    expect(scim).toContain('from "@/components/ui/button"');
    expect(scim).toContain('from "@/components/ui/switch"');
    expect(scim).toContain("Rotate Token");
    expect(scim).not.toMatch(/className="px-4 py-2 bg-\[var\(--warning-bg\)\]/);

    const mcp = read("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(mcp).toContain('variant={target === id ? "secondary" : "ghost"}');

    const refs = read("app/(portal)/settings/_components/references-tab.tsx");
    expect(refs).toContain('aria-label={`Delete ${ref.name}`}');
    expect(refs).toContain("<Button");
    expect(refs).not.toMatch(/<button\s+onClick=\{\(\) => handleDelete/);

    const sidebar = read("app/(portal)/settings/_components/sidebar-settings-view.tsx");
    expect(sidebar).toContain("Reset to default");
    expect(sidebar).toContain("<Button");
    expect(sidebar).not.toMatch(/const resetButton = <button/);
  });
});
