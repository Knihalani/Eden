/**
 * Phase 1 IA contract — sidebar + mobile nav vs PHASES §1.5 / IA §1.
 */

import { describe, expect, it } from "vitest";
import {
  CORE_NAV_ITEM_COUNT,
  CORE_NAV_LEAF_IDS,
  DEFAULT_SIDEBAR,
  MOBILE_BOTTOM_NAV,
  STUB_SURFACE_IDS,
  getCoreNavLeaves,
} from "@/lib/sidebar-config";

const EXPECTED_LEAF_IDS = [
  "dashboard",
  "agents",
  "traces",
  "issues",
  "alerts",
  "evals",
  "improve",
  "guardrails",
  "cost",
  "agent",
  "audit",
  "settings",
] as const;

const EXPECTED_MOBILE_HREFS = [
  "/dashboard",
  "/traces",
  "/issues",
  "/evals",
  "/improve",
] as const;

describe("rebuild IA contract", () => {
  it("exports CORE_NAV_ITEM_COUNT === 12", () => {
    expect(CORE_NAV_ITEM_COUNT).toBe(12);
    expect(CORE_NAV_LEAF_IDS).toHaveLength(12);
  });

  it("sidebar leaf ids match the 12 IA ids", () => {
    const ids = getCoreNavLeaves().map((i) => i.id);
    expect(ids).toEqual([...EXPECTED_LEAF_IDS]);
    expect([...CORE_NAV_LEAF_IDS]).toEqual([...EXPECTED_LEAF_IDS]);
  });

  it("Sessions is not a core nav leaf", () => {
    expect(CORE_NAV_LEAF_IDS).not.toContain("sessions");
    expect(getCoreNavLeaves().some((i) => i.id === "sessions")).toBe(false);
  });

  it("no sidebar href contains redteam", () => {
    const hrefs = DEFAULT_SIDEBAR.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs.some((h) => h.includes("redteam"))).toBe(false);
  });

  it("dashboard href is /dashboard", () => {
    const dash = getCoreNavLeaves().find((i) => i.id === "dashboard");
    expect(dash?.href).toBe("/dashboard");
  });

  it("agents href is /agents", () => {
    const agents = getCoreNavLeaves().find((i) => i.id === "agents");
    expect(agents?.href).toBe("/agents");
  });

  it("agent and agents are distinct ids", () => {
    const ids = getCoreNavLeaves().map((i) => i.id);
    expect(ids.filter((id) => id === "agent")).toHaveLength(1);
    expect(ids.filter((id) => id === "agents")).toHaveLength(1);
    expect(ids.includes("agent")).toBe(true);
    expect(ids.includes("agents")).toBe(true);
  });

  it("mobile bottom nav length === 5 with Phase 1 hrefs", () => {
    expect(MOBILE_BOTTOM_NAV).toHaveLength(5);
    expect(MOBILE_BOTTOM_NAV.map((i) => i.href)).toEqual([
      ...EXPECTED_MOBILE_HREFS,
    ]);
  });

  it("Observe leaves use live hrefs (not /_stub)", () => {
    const leaves = getCoreNavLeaves();
    expect(leaves.find((i) => i.id === "traces")?.href).toBe("/traces");
    expect(leaves.find((i) => i.id === "issues")?.href).toBe("/issues");
    expect(leaves.find((i) => i.id === "alerts")?.href).toBe("/alerts");
  });

  it("STUB_SURFACE_IDS is empty after Phase 7 (all 12 leaves live)", () => {
    expect(STUB_SURFACE_IDS).toEqual([]);
    for (const id of CORE_NAV_LEAF_IDS) {
      expect(STUB_SURFACE_IDS).not.toContain(id);
    }
  });

  it("evals href is live /evals", () => {
    const evals = getCoreNavLeaves().find((i) => i.id === "evals");
    expect(evals?.href).toBe("/evals");
  });

  it("Improve group leaves use live hrefs", () => {
    const leaves = getCoreNavLeaves();
    expect(leaves.find((i) => i.id === "improve")?.href).toBe("/improve");
    expect(leaves.find((i) => i.id === "guardrails")?.href).toBe("/guardrails");
    expect(leaves.find((i) => i.id === "cost")?.href).toBe("/cost");
  });

  it("agent href is live /agent (Phase 6)", () => {
    const leaves = getCoreNavLeaves();
    expect(leaves.find((i) => i.id === "agent")?.href).toBe("/agent");
  });

  it("audit and settings are live (Phase 7)", () => {
    const leaves = getCoreNavLeaves();
    expect(leaves.find((i) => i.id === "audit")?.href).toBe("/audit");
    expect(leaves.find((i) => i.id === "settings")?.href).toBe("/settings");
  });
});
