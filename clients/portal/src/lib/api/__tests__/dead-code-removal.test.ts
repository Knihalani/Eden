/**
 * Regression guards for API-layer dead-code removals.
 *
 * - F41-4: ``aiInsightsChat`` was deleted (hand-rolled fetch bypass).
 * - Portal prune: zero-consumer ``*Api`` namespaces removed from
 *   ``resources.ts``; domain facade barrels deleted.
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
    "agentIssuesApi",
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
    "fleetApi",
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
