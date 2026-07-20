/**
 * W4-E — Opportunistic bug-fix regressions:
 * - SPA navigation instead of full reloads on hub cross-links
 * - NoOrgState on agent/artifact surfaces (no infinite spinner)
 * - Agent API routes map upstream failures via proxyError (502 JSON)
 * - Dead (portal)/[...notFound] catch-all removed
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W4-E opportunistic bug-fix", () => {
  it("traces/issues/alerts/datasets use router.push (not window.location.href)", () => {
    for (const rel of [
      "app/(portal)/traces/page.tsx",
      "app/(portal)/issues/page.tsx",
      "app/(portal)/alerts/page.tsx",
      "app/(portal)/datasets/page.tsx",
      "app/(portal)/datasets/[id]/page.tsx",
      "app/(portal)/labeling/queues/[id]/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/useRouter/);
      expect(src).not.toMatch(/window\.location\.href\s*=/);
    }
  });

  it("agent artifact/drift/ledger + artifacts hub render NoOrgState", () => {
    for (const rel of [
      "app/(portal)/agents/[id]/artifacts/page.tsx",
      "app/(portal)/agents/[id]/drift/page.tsx",
      "app/(portal)/agents/[id]/ledger/page.tsx",
      "app/(portal)/artifacts/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/NoOrgState/);
      expect(src).toMatch(/if\s*\(\s*!currentOrg\s*\)/);
    }
  });

  it("agent sim/test run API routes catch with proxyError", () => {
    for (const rel of [
      "app/api/agents/[id]/sim-runs/route.ts",
      "app/api/agents/[id]/sim-runs/[run_id]/route.ts",
      "app/api/agents/[id]/test-runs/route.ts",
      "app/api/agents/[id]/test-runs/[run_id]/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/proxyError/);
      expect(src).toMatch(/try\s*\{/);
    }
  });

  it("removes dead (portal)/[...notFound] catch-all segment", () => {
    expect(
      existsSync(resolve(portalSrc, "app/(portal)/[...notFound]")),
    ).toBe(false);
    expect(existsSync(resolve(portalSrc, "app/[...notFound]/page.tsx"))).toBe(
      true,
    );
  });
});
