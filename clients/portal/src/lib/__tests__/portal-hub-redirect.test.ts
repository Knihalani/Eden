import { describe, expect, it } from "vitest";
import { buildHubRedirectUrl } from "@/lib/portal-hub-redirect";
import { datasetHref } from "@/lib/portal-cross-links";

describe("portal hub redirect merge", () => {
  it("merges promote_trace and sets tab=datasets for /datasets", () => {
    const target = buildHubRedirectUrl(
      "/datasets",
      "?promote_trace=trace-abc",
    );
    expect(target).toBe("/evals?promote_trace=trace-abc&tab=datasets");
  });

  it("does not overwrite an existing tab param", () => {
    const target = buildHubRedirectUrl(
      "/datasets",
      "?tab=playgrounds&promote_trace=x",
    );
    expect(target).toBe("/evals?tab=playgrounds&promote_trace=x");
  });

  it("redirects bare /playgrounds to evals playgrounds tab", () => {
    expect(buildHubRedirectUrl("/playgrounds", "")).toBe(
      "/evals?tab=playgrounds",
    );
  });

  it("soft-nests observability facets under traces with query merge", () => {
    expect(buildHubRedirectUrl("/observability/mcp", "?filter=auth")).toBe(
      "/traces?filter=auth&facet=mcp",
    );
    expect(
      buildHubRedirectUrl("/observability/decisions", "?pastHours=24"),
    ).toBe("/traces?pastHours=24&facet=decisions");
    expect(buildHubRedirectUrl("/observability/memory", "")).toBe(
      "/traces?facet=memory",
    );
    expect(buildHubRedirectUrl("/observability/retrieval", "")).toBe(
      "/traces?facet=retrieval",
    );
  });

  it("routes time-travel to debugger; cohorts stays on traces", () => {
    expect(
      buildHubRedirectUrl("/observability/time-travel", "?filter=x"),
    ).toBe("/debugger?filter=x&tab=time-travel");
    expect(buildHubRedirectUrl("/observability/cohorts", "")).toBe("/traces");
  });

  it("does not overwrite an explicit facet on observability nests", () => {
    expect(
      buildHubRedirectUrl("/observability/mcp", "?facet=decisions"),
    ).toBe("/traces?facet=decisions");
  });

  it("does not hijack live /debugger (must-ship Phase 6)", () => {
    expect(buildHubRedirectUrl("/debugger", "")).toBeNull();
    expect(buildHubRedirectUrl("/debugger", "?tab=replay")).toBeNull();
  });

  it("maps replay + redteam + cost farms to live hubs", () => {
    expect(buildHubRedirectUrl("/replay", "")).toBe("/debugger?tab=replay");
    expect(buildHubRedirectUrl("/redteam", "")).toBe(
      "/guardrails?tab=policies",
    );
    expect(buildHubRedirectUrl("/optimization/budget", "")).toBe(
      "/cost?tab=budget",
    );
    expect(buildHubRedirectUrl("/promotions", "")).toBe(
      "/improve?tab=promotions",
    );
  });
});

describe("datasetHref hub URL", () => {
  it("uses evals datasets tab for list links", () => {
    expect(datasetHref()).toBe("/evals?tab=datasets");
    expect(datasetHref("ds-1")).toBe("/datasets/ds-1");
  });
});
