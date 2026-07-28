/**
 * Regression test for F41-4: ``aiInsightsChat`` was dead code (zero
 * callers anywhere in src/app, src/components, src/hooks) that
 * bypassed ``fetchApi`` via a hand-rolled ``fetch()`` — it was
 * deleted from ``resources.ts`` along with its re-export in
 * ``observability.ts`` rather than fixed. Guard against it quietly
 * reappearing.
 */
import { describe, expect, it } from "vitest";

describe("aiInsightsChat removal (F41-4)", () => {
  it("is no longer exported from resources.ts", async () => {
    const resources = await import("../resources");
    expect(resources).not.toHaveProperty("aiInsightsChat");
  });

  it("is no longer re-exported from observability.ts", async () => {
    const observability = await import("../observability");
    expect(observability).not.toHaveProperty("aiInsightsChat");
  });
});
