/**
 * Phase 2 Agents contract — surfaces/agents.md acceptance.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";

const portalSrc = path.resolve(__dirname, "../../../..");
const agentsRoot = path.join(portalSrc, "app/(portal)/agents");
const nextConfig = path.join(portalSrc, "../next.config.ts");

describe("rebuild agents contract", () => {
  it("required routes exist", () => {
    expect(existsSync(path.join(agentsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(agentsRoot, "connect/page.tsx"))).toBe(true);
    expect(existsSync(path.join(agentsRoot, "[id]/page.tsx"))).toBe(true);
    expect(existsSync(path.join(agentsRoot, "[id]/ledger/page.tsx"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(agentsRoot, "[id]/artifacts/page.tsx")),
    ).toBe(true);
  });

  it("list supports tab=list|fleet", () => {
    const src = readFileSync(path.join(agentsRoot, "page.tsx"), "utf8");
    expect(src).toContain('"fleet"');
    expect(src).toContain('"list"');
    expect(src).toMatch(/tab.*fleet|fleet.*tab/);
  });

  it("connect has Gateway and SDK panels", () => {
    const connect = readFileSync(
      path.join(agentsRoot, "connect/page.tsx"),
      "utf8",
    );
    expect(connect).toContain("ConnectGatewayPanel");
    expect(connect).toContain("ConnectSdkPanel");
    expect(connect).toContain("connect-troubleshoot");
    expect(connect).not.toContain("OnboardingConnectFlow");
  });

  it("detail peeks lack nested hub PageHeaders", () => {
    const detail = readFileSync(
      path.join(agentsRoot, "[id]/page.tsx"),
      "utf8",
    );
    // One PageHeader for the agent home — peeks use Panel, not nested PageHeader
    const headers = detail.match(/<PageHeader/g) ?? [];
    expect(headers.length).toBe(1);
    expect(detail).toContain("/traces?agentId=");
    expect(detail).toContain("/issues?agentId=");
    expect(detail).not.toContain("/_stub/traces");
    expect(detail).not.toContain("/_stub/issues");
    expect(detail).toContain("/improve?");
    expect(detail).toContain("/cost?agentId=");
    expect(detail).toContain("/guardrails?agentId=");
    expect(detail).not.toContain("EmbeddedSurface");
    expect(detail).not.toContain("CoreResourcePage");
  });

  it("redirects for artifacts/book/drift/sim/test exist", () => {
    expect(
      existsSync(path.join(agentsRoot, "[id]/artifacts/page.tsx")),
    ).toBe(true);
    expect(existsSync(path.join(agentsRoot, "[id]/book/page.tsx"))).toBe(
      true,
    );
    expect(existsSync(path.join(agentsRoot, "[id]/drift/page.tsx"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(agentsRoot, "[id]/sim-runs/page.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(agentsRoot, "[id]/test-runs/page.tsx")),
    ).toBe(true);

    const artifacts = readFileSync(
      path.join(agentsRoot, "[id]/artifacts/page.tsx"),
      "utf8",
    );
    expect(artifacts).toContain("/improve?tab=artifacts&agentId=");

    const cfg = readFileSync(nextConfig, "utf8");
    expect(cfg).toContain('destination: "/agents?tab=fleet"');
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/agents"/);
    expect(softLandBody).not.toMatch(/"\/fleet"/);
  });

  it("agents sidebar href is live /agents", () => {
    const agents = getCoreNavLeaves().find((i) => i.id === "agents");
    expect(agents?.href).toBe("/agents");
  });
});
