/**
 * Later — Prompts registry contract (surfaces/prompts.md).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_NAV_LEAF_IDS,
  MOBILE_MORE_NAV,
  getCoreNavLeaves,
} from "@/lib/sidebar-config";

const portalSrc = path.resolve(__dirname, "../../../..");
const promptsRoot = path.join(portalSrc, "app/(portal)/prompts");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");
const palette = path.join(portalSrc, "components/ui/command-palette.tsx");

describe("later prompts contract", () => {
  it("live /prompts route exists", () => {
    expect(existsSync(path.join(promptsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(promptsRoot, "loading.tsx"))).toBe(true);
  });

  it("not a core sidebar leaf; More + Cmd+K entry points", () => {
    expect(CORE_NAV_LEAF_IDS).not.toContain("prompts");
    expect(getCoreNavLeaves().some((i) => i.id === "prompts")).toBe(false);
    expect(MOBILE_MORE_NAV.some((i) => i.href === "/prompts")).toBe(true);

    const page = readFileSync(path.join(promptsRoot, "page.tsx"), "utf8");
    expect(page).toContain("data-phase-later-prompts");
    expect(page).toContain("ResourcePageShell");
    expect(page).toContain("DetailPanelShell");
    expect(page).not.toContain("EmbeddedSurface");
    expect(page).toContain("/evals?tab=playgrounds");
    expect(page).toContain("/improve?tab=artifacts");

    const cmd = readFileSync(palette, "utf8");
    expect(cmd).toContain('"/prompts"');
  });

  it("softLand excludes /prompts", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/prompts"/);
  });

  it("i18n prompts in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      prompts?: { title?: string };
      nav?: { leaves?: { prompts?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      prompts?: { title?: string };
      nav?: { leaves?: { prompts?: string } };
    };
    expect(en.prompts?.title).toBeTruthy();
    expect(de.prompts?.title).toBeTruthy();
    expect(en.nav?.leaves?.prompts).toBe("Prompts");
    expect(de.nav?.leaves?.prompts).toBeTruthy();
  });
});
