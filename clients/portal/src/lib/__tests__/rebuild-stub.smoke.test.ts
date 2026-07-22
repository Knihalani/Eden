import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_NAV_ITEM_COUNT,
  DEFAULT_SIDEBAR,
  STUB_CORE_SURFACE_IDS,
} from "@/lib/sidebar-config";

const portalRoot = path.resolve(__dirname, "../..");

describe("rebuild stub smoke", () => {
  it("has no redteam page under (portal)", () => {
    expect(
      existsSync(path.join(portalRoot, "app/(portal)/redteam/page.tsx")),
    ).toBe(false);
    expect(existsSync(path.join(portalRoot, "app/(portal)/redteam"))).toBe(
      false,
    );
  });

  it("stub sidebar has ≤12 core leaves and no redteam", () => {
    const coreItems = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
      (i) => i.category !== "advanced",
    );
    expect(coreItems.length).toBeLessThanOrEqual(12);
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
    expect(STUB_CORE_SURFACE_IDS).toHaveLength(12);
    expect(coreItems.map((i) => i.id).sort()).toEqual(
      [...STUB_CORE_SURFACE_IDS].sort(),
    );
    expect(coreItems.some((i) => i.id === "redteam" || i.href.includes("redteam"))).toBe(
      false,
    );
    expect(coreItems.some((i) => i.id === "sessions")).toBe(false);
  });

  it("dashboard stub page exists", () => {
    expect(
      existsSync(path.join(portalRoot, "app/(portal)/dashboard/page.tsx")),
    ).toBe(true);
  });
});
