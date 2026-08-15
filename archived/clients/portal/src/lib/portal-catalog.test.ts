import { describe, expect, it, beforeEach } from "vitest";
import {
  clearPortalCatalog,
  getPortalCatalog,
  patchPortalCatalog,
  catalogAgents,
} from "@/lib/portal-catalog";

describe("portal-catalog", () => {
  beforeEach(() => {
    clearPortalCatalog();
  });

  it("starts empty", () => {
    expect(catalogAgents()).toEqual([]);
    expect(getPortalCatalog().orgId).toBeNull();
  });

  it("patches agents and orgId", () => {
    patchPortalCatalog({
      orgId: "org_1",
      agents: [
        {
          id: "a1",
          name: "Agent",
          purpose: "",
          status: "live",
          env: "prod",
          model: "gpt",
          runs24h: 1,
          successRate: 1,
          errorRate: 0,
          p50Ms: 10,
          p95Ms: 20,
          costUsd24h: 0.1,
          tokens24h: 100,
          openIssues: 0,
          lastSeen: "",
        },
      ],
    });
    expect(getPortalCatalog().orgId).toBe("org_1");
    expect(catalogAgents()).toHaveLength(1);
    expect(catalogAgents()[0]?.id).toBe("a1");
  });

  it("clear resets", () => {
    patchPortalCatalog({ orgId: "x", agents: [] });
    clearPortalCatalog();
    expect(getPortalCatalog().orgId).toBeNull();
  });

  it("merges partial patches", () => {
    patchPortalCatalog({ orgId: "o1", traces: [] });
    patchPortalCatalog({
      issues: [
        {
          id: "i1",
          title: "t",
          summary: "",
          body: "",
          severity: "error",
          status: "open",
          agentId: "a1",
          fingerprint: "",
          detector: "",
          environment: "",
          occurrenceTraceIds: [],
          firstSeen: "",
          lastSeen: "",
          signalCount: 0,
          errorSample: "",
          impact: "",
          suggestedFix: "",
          tags: [],
        },
      ],
    });
    expect(getPortalCatalog().orgId).toBe("o1");
    expect(getPortalCatalog().issues).toHaveLength(1);
  });
});
