import { describe, expect, it } from "vitest";
import { CORE_NAV_ITEM_COUNT } from "@/lib/sidebar-config";
import { isKnownPortalPath, KNOWN_PORTAL_PREFIXES } from "@/lib/portal-routes";
import {
  buildNavCommands,
  collectSidebarHrefs,
  PALETTE_ACTIONS,
} from "@/lib/nav-commands";
import { MOBILE_CORE_NAV } from "@/components/portal-os/MobileBottomNav";
import { isExternalHref } from "@/lib/utils";

describe("U12 sidebar IA", () => {
  it("has at most 12 core nav items", () => {
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
  });
});

describe("portal-routes", () => {
  it("includes Phase 2 observe routes", () => {
    for (const prefix of ["/traces", "/sessions", "/artifacts", "/ledger"]) {
      expect(KNOWN_PORTAL_PREFIXES).toContain(prefix);
    }
  });

  it("recognizes session detail paths", () => {
    expect(isKnownPortalPath("/sessions/abc-123")).toBe(true);
    expect(isKnownPortalPath("/traces")).toBe(true);
  });
});

describe("U18 route agreement", () => {
  it("maps every sidebar href prefix to a known portal route", () => {
    const hrefs = collectSidebarHrefs().filter((h) => !isExternalHref(h));
    for (const href of hrefs) {
      expect(isKnownPortalPath(href)).toBe(true);
    }
  });

  it("includes core evaluate routes in portal-routes", () => {
    for (const prefix of ["/playgrounds", "/experiments", "/datasets", "/evals"]) {
      expect(KNOWN_PORTAL_PREFIXES).toContain(prefix);
    }
  });
});

describe("U18 command palette", () => {
  it("exposes at least five quick actions", () => {
    expect(PALETTE_ACTIONS.length).toBeGreaterThanOrEqual(5);
  });

  it("includes actions in buildNavCommands output", () => {
    const cmds = buildNavCommands();
    const actions = cmds.filter((c) => c.kind === "action");
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });
});

describe("U18 mobile shell", () => {
  it("locks bottom nav to four core items plus More sheet", () => {
    expect(MOBILE_CORE_NAV).toHaveLength(4);
    expect(MOBILE_CORE_NAV.map((i) => i.href)).toEqual([
      "/dashboard",
      "/traces",
      "/issues",
      "/improve",
    ]);
  });
});
