/**
 * Regression guards for API-layer dead-code removals.
 *
 * - F41-4: ``aiInsightsChat`` was deleted (hand-rolled fetch bypass).
 * - Portal prune: zero-consumer ``*Api`` namespaces removed from
 *   ``resources.ts``; domain facade barrels deleted.
 * - FEAT-66: ``fleetApi`` is deliberately reinstated with a single
 *   ``delegationGraph`` method backing the new agent-detail
 *   "Delegation" tab (``GET /orgs/{org_id}/fleet/delegation``). It stays
 *   out of ``deletedNamespaces`` below and gets its own presence check
 *   instead — every *other* previously zero-consumer namespace must
 *   still stay deleted.
 */
import { describe, expect, it } from "vitest";

describe("aiInsightsChat removal (F41-4)", () => {
  it("is no longer exported from resources.ts", async () => {
    const resources = await import("../resources");
    expect(resources).not.toHaveProperty("aiInsightsChat");
  });
});

describe("zero-consumer Api namespaces stay deleted", () => {
  const deletedNamespaces = [
    "a2aApi",
    "adminStatusApi",
    "agentSessionsApi",
    "apmApi",
    "autonomousApi",
    "closedLoopApi",
    "columnarApi",
    "complianceApi",
    "computerUseApi",
    "dslApi",
    "evalApi",
    "experimentsApi",
    "fineTuneApi",
    "governanceApi",
    "guardrailsApi",
    "improveApi",
    "improveRunsApi",
    "integrationsApi",
    "intelligenceAgentsApi",
    "learnApi",
    "mcpApi",
    "memoryApi",
    "metricStudioApi",
    "modelAdvisorApi",
    "nlAlertsApi",
    "onboardingApi",
    "onboardingV2Api",
    "outcomesApi",
    "predictiveApi",
    "providerRoutingApi",
    "rcaApi",
    "replayApi",
    "retrievalApi",
    "savedViewsApi",
    "toolsApi",
    "userApi",
    "voiceApi",
  ] as const;

  it("are not re-exported from resources.ts", async () => {
    const resources = await import("../resources");
    for (const name of deletedNamespaces) {
      expect(resources).not.toHaveProperty(name);
    }
  });
});

describe("wave6Api stays exported (restored online-quality surface)", () => {
  it("is exported from resources.ts", async () => {
    const resources = await import("../resources");
    expect(resources).toHaveProperty("wave6Api");
  });
});

describe("fleetApi stays exported (FEAT-66 delegation graph panel)", () => {
  it("is exported from resources.ts with a delegationGraph method", async () => {
    const resources = await import("../resources");
    expect(resources).toHaveProperty("fleetApi");
    const fleetApi = (resources as { fleetApi?: Record<string, unknown> }).fleetApi;
    expect(typeof fleetApi?.delegationGraph).toBe("function");
  });
});
