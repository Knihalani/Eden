/**
 * Phase 2 Dashboard contract — surfaces/dashboard.md acceptance.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDiagnosis,
  buildNextAction,
} from "@/lib/agent-health";

const portalSrc = path.resolve(__dirname, "../../../..");
const dashboardPage = path.join(
  portalSrc,
  "app/(portal)/dashboard/page.tsx",
);
const dashboardDir = path.join(portalSrc, "app/(portal)/dashboard");

function walkTsx(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTsx(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("rebuild dashboard contract", () => {
  it("empty CTA targets /agents/connect", () => {
    const src = readFileSync(dashboardPage, "utf8");
    expect(src).toContain('href="/agents/connect"');
    expect(src).not.toContain('href="/_stub/agents"');
  });

  it("does not import home-kpi-strip or KPI collage", () => {
    const files = walkTsx(dashboardDir);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/home-kpi-strip/);
      expect(src).not.toMatch(/HomeKpiStrip/);
    }
  });

  it("diagnosis and next-action kinds match surface contract", () => {
    const d = buildDiagnosis({
      openIssueCount: 1,
      errorTraceCount: 2,
      windowHours: 24,
      worstAgentId: "a1",
      worstAgentName: "bot",
      agentCount: 1,
      traceCountEver: 3,
    });
    expect(d.primaryHref).toContain("/issues");
    expect(d).toMatchObject({
      openIssueCount: 1,
      errorTraceCount: 2,
      windowHours: 24,
    });

    const kinds = [
      buildNextAction({
        agentCount: 0,
        traceCountEver: 0,
        openIssueCount: 0,
        errorTraceCount: 0,
      }).kind,
      buildNextAction({
        agentCount: 1,
        traceCountEver: 1,
        openIssueCount: 1,
        errorTraceCount: 0,
      }).kind,
      buildNextAction({
        agentCount: 1,
        traceCountEver: 1,
        openIssueCount: 0,
        errorTraceCount: 2,
      }).kind,
      buildNextAction({
        agentCount: 1,
        traceCountEver: 1,
        openIssueCount: 0,
        errorTraceCount: 0,
        worstStatus: "healthy",
      }).kind,
    ];
    expect(kinds).toEqual([
      "connect",
      "open_issue",
      "review_failures",
      "healthy",
    ]);
  });

  it("live Observe cross-links preserve query ids", () => {
    const next = readFileSync(
      path.join(dashboardDir, "_components/next-action-panel.tsx"),
      "utf8",
    );
    expect(next).toContain("/traces?traceId=");
    expect(next).not.toContain("/_stub/traces");
    expect(next).not.toContain("/_stub/issues");
  });
});
