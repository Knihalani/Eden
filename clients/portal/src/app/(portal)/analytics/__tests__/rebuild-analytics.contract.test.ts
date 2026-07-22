/**
 * Later — Analytics product hub contract (surfaces/analytics.md).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_NAV_LEAF_IDS,
  MOBILE_MORE_NAV,
  getCoreNavLeaves,
} from "@/lib/sidebar-config";
import { ANALYTICS_TABS } from "@/lib/analytics-url";

const portalSrc = path.resolve(__dirname, "../../../..");
const analyticsRoot = path.join(portalSrc, "app/(portal)/analytics");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");
const palette = path.join(portalSrc, "components/ui/command-palette.tsx");

describe("later analytics contract", () => {
  it("live /analytics route exists", () => {
    expect(existsSync(path.join(analyticsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(analyticsRoot, "loading.tsx"))).toBe(true);
  });

  it("tabs overview|insights|topics|tools|users; not a core leaf", () => {
    expect([...ANALYTICS_TABS]).toEqual([
      "overview",
      "insights",
      "topics",
      "tools",
      "users",
    ]);
    expect(CORE_NAV_LEAF_IDS).not.toContain("analytics");
    expect(getCoreNavLeaves().some((i) => i.id === "analytics")).toBe(false);
    expect(MOBILE_MORE_NAV.some((i) => i.href === "/analytics")).toBe(true);

    const page = readFileSync(path.join(analyticsRoot, "page.tsx"), "utf8");
    expect(page).toContain("data-phase-later-analytics");
    expect(page).toContain("ResourcePageShell");
    expect(page).not.toContain("EmbeddedSurface");
    expect(page).not.toMatch(/red-?team/i);

    const cmd = readFileSync(palette, "utf8");
    expect(cmd).toContain('"/analytics"');
  });

  it("softLand excludes /analytics; aliases redirect into tabs", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/analytics"/);
    expect(softLandBody).not.toMatch(/"\/users"/);
    expect(softLandBody).not.toMatch(/"\/tools"/);
    expect(softLandBody).not.toMatch(/"\/insights"/);

    expect(cfg).toMatch(/source: ["']\/users["']/);
    expect(cfg).toMatch(/destination: ["']\/analytics\?tab=users["']/);
    expect(cfg).toMatch(/source: ["']\/tools["']/);
    expect(cfg).toMatch(/destination: ["']\/analytics\?tab=tools["']/);
    expect(cfg).toMatch(/source: ["']\/insights["']/);
    expect(cfg).toMatch(/destination: ["']\/analytics\?tab=insights["']/);
    expect(cfg).toMatch(/source: ["']\/insights\/topics["']/);
    expect(cfg).toMatch(/destination: ["']\/analytics\?tab=topics["']/);
  });

  it("i18n analytics in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      analytics?: { title?: string; tabs?: { overview?: string } };
      nav?: { leaves?: { analytics?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      analytics?: { title?: string };
      nav?: { leaves?: { analytics?: string } };
    };
    expect(en.analytics?.title).toBeTruthy();
    expect(de.analytics?.title).toBeTruthy();
    expect(en.nav?.leaves?.analytics).toBe("Analytics");
    expect(de.nav?.leaves?.analytics).toBeTruthy();
    expect(en.analytics?.tabs?.overview).toBeTruthy();
  });
});
