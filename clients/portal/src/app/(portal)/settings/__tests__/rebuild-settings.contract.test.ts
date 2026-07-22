/**
 * Phase 7 Settings contract — surfaces/settings.md acceptance (hub chrome / IA).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import {
  SETTINGS_DAILY_TAB_IDS,
  SETTINGS_AUDIT_LOG_REDIRECT_HREF,
  WAVE9_DAILY_TAB_CAP,
  DEFAULT_VISIBLE_TAB_IDS,
  GHOST_TABS,
} from "@/app/(portal)/settings/_components/settings-tab-registry";

const portalSrc = path.resolve(__dirname, "../../../..");
const settingsRoot = path.join(portalSrc, "app/(portal)/settings");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("rebuild settings contract", () => {
  it("required hub routes exist", () => {
    expect(existsSync(path.join(settingsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(settingsRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(
        path.join(settingsRoot, "_components/settings-tab-registry.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(settingsRoot, "_components/gateway-tab.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(settingsRoot, "_components/api-keys-tab.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(settingsRoot, "_components/overview-panel.tsx")),
    ).toBe(true);
  });

  it("daily tabs ≤8 with gateway + api-keys first-class", () => {
    expect(WAVE9_DAILY_TAB_CAP).toBe(8);
    expect(SETTINGS_DAILY_TAB_IDS).toHaveLength(8);
    expect(DEFAULT_VISIBLE_TAB_IDS).toHaveLength(8);
    expect([...SETTINGS_DAILY_TAB_IDS]).toEqual([
      "overview",
      "account",
      "org",
      "members",
      "api-keys",
      "gateway",
      "billing",
      "security",
    ]);
    expect(SETTINGS_AUDIT_LOG_REDIRECT_HREF).toBe("/audit");
    expect(GHOST_TABS.has("roles")).toBe(true);
    expect(GHOST_TABS.has("sso")).toBe(true);
  });

  it("no second Settings rail and no EmbeddedSurface", () => {
    const page = readFileSync(path.join(settingsRoot, "page.tsx"), "utf8");
    expect(page).toContain("settings-advanced");
    expect(page).toContain("SETTINGS_DAILY_TAB_IDS");
    expect(page).not.toContain("w-[240px]");
    expect(page).not.toContain("EmbeddedSurface");

    for (const f of walkTs(settingsRoot)) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("EmbeddedSurface");
      expect(src).not.toMatch(/red-?team/i);
    }
  });

  it("sidebar settings href is live /settings", () => {
    const settings = getCoreNavLeaves().find((i) => i.id === "settings");
    expect(settings?.href).toBe("/settings");
  });

  it("softLand excludes /settings; profile/billing/finops redirect into tabs", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/settings"/);
    expect(softLandBody).not.toMatch(/"\/profile"/);
    expect(softLandBody).not.toMatch(/"\/billing"/);
    expect(softLandBody).not.toMatch(/"\/finops"/);

    expect(cfg).toMatch(/source: ["']\/profile["']/);
    expect(cfg).toMatch(/destination: ["']\/settings\?tab=account["']/);
    expect(cfg).toMatch(/source: ["']\/billing["']/);
    expect(cfg).toMatch(/destination: ["']\/settings\?tab=billing["']/);
    expect(cfg).toMatch(/source: ["']\/finops["']/);
    expect(cfg).toMatch(/destination: ["']\/settings\?tab=finops["']/);
  });

  it("i18n settings namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      settings?: { title?: string };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      settings?: { title?: string };
    };
    expect(en.settings?.title).toBeTruthy();
    expect(de.settings?.title).toBeTruthy();
  });
});
