import { describe, expect, it } from "vitest";
import {
  CROSS_LINK_MATRIX,
  artifactHref,
  datasetHref,
  driftHref,
  experimentHref,
  incidentHref,
  issueHref,
  labelingQueueHref,
  ledgerHref,
  playgroundHref,
  promotionsHref,
  traceHref,
  tracesFilteredHref,
} from "@/lib/portal-cross-links";

describe("U19 cross-link matrix", () => {
  it("defines all required matrix entries from spec §3", () => {
    const pairs = CROSS_LINK_MATRIX.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain("trace->issue");
    expect(pairs).toContain("trace->artifact");
    expect(pairs).toContain("trace->playground");
    expect(pairs).toContain("trace->dataset");
    expect(pairs).toContain("trace->labeling");
    expect(pairs).toContain("issue->experiment");
    expect(pairs).toContain("issue->artifact");
    expect(pairs).toContain("alert->incident");
    expect(pairs).toContain("alert->trace");
    expect(pairs).toContain("artifact->trace");
    expect(pairs).toContain("drift->trace");
    expect(pairs).toContain("dataset->playground");
    expect(pairs).toContain("dataset->experiment");
    expect(pairs).toContain("experiment->trace");
    expect(CROSS_LINK_MATRIX.length).toBeGreaterThanOrEqual(14);
  });

  it("builds shareable trace deep links", () => {
    expect(traceHref("abc-123")).toBe("/traces?traceId=abc-123");
  });

  it("builds issue panel deep links", () => {
    expect(issueHref("iss-1")).toBe("/issues?issueId=iss-1");
  });

  it("builds artifact deep links with optional selection", () => {
    expect(artifactHref()).toBe("/artifacts");
    expect(artifactHref("nudge-1")).toBe("/artifacts?artifactId=nudge-1");
  });

  it("builds playground links with trace context", () => {
    expect(playgroundHref("t1", "s1")).toContain("trace_id=t1");
    expect(playgroundHref("t1", "s1")).toContain("span_id=s1");
    expect(playgroundHref("t1", "s1")).toContain("tab=playgrounds");
    expect(playgroundHref()).toBe("/evals?tab=playgrounds");
  });

  it("builds dataset and experiment links", () => {
    expect(datasetHref()).toBe("/evals?tab=datasets");
    expect(datasetHref("ds-1")).toBe("/datasets/ds-1");
    expect(experimentHref("exp-1", "iss-1")).toContain("experimentId=exp-1");
    expect(experimentHref("exp-1", "iss-1")).toContain("issueId=iss-1");
    expect(experimentHref("exp-1", "iss-1")).toContain("tab=experiments");
    expect(experimentHref()).toBe("/evals?tab=experiments");
  });

  it("builds ledger and drift agent routes", () => {
    expect(ledgerHref("agent-a")).toBe("/agents/agent-a/ledger");
    expect(driftHref("agent-a", "stumble_rate")).toContain("/agents/agent-a/drift");
    expect(driftHref("agent-a", "stumble_rate")).toContain("dimension=stumble_rate");
  });

  it("builds filtered trace hub links for drift drill-down", () => {
    const href = tracesFilteredHref({ agent_id: "a1", dimension: "cost" });
    expect(href).toContain("/traces");
    expect(href).toContain("agent_id=a1");
  });

  it("builds labeling and incident routes", () => {
    expect(labelingQueueHref("q1")).toBe("/labeling/queues/q1");
    expect(labelingQueueHref()).toBe("/evals?tab=labeling");
    expect(incidentHref()).toBe("/issues?tab=incidents");
    expect(promotionsHref()).toBe("/promotions");
  });
});

describe("U19 portal-os exports", () => {
  it(
    "exports cross-link and drift UI primitives",
    async () => {
      // Import components directly — the barrel re-exports AppShell/CommandPalette
      // and can exceed the default 5s vitest timeout on cold CI runners.
      const [crossLink, drift, barrel] = await Promise.all([
        import("@/components/portal-os/CrossLinkBar"),
        import("@/components/portal-os/DriftHistogram"),
        import("@/components/portal-os"),
      ]);
      expect(crossLink.CrossLinkBar).toBeDefined();
      expect(drift.DriftHistogram).toBeDefined();
      expect(barrel.CrossLinkBar).toBeDefined();
      expect(barrel.DriftHistogram).toBeDefined();
    },
    20_000,
  );
});
