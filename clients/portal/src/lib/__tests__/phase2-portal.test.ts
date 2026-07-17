import { describe, expect, it } from "vitest";
import { CORE_NAV_ITEM_COUNT } from "@/lib/sidebar-config";
import { isKnownPortalPath, KNOWN_PORTAL_PREFIXES } from "@/lib/portal-routes";

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
