/**
 * Phase 3 Issues contract — surfaces/issues.md acceptance (C3/C4).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCreatePlanHref,
  buildOpenTraceHref,
  hasPlanEvidence,
  isIncidentCluster,
  mapIssue,
  mapStumbleToFinding,
  parseIssuesTab,
} from "../_components/issue-map";
import type { AgentIssue, AgentStumble } from "@/lib/api";

const portalSrc = path.resolve(__dirname, "../../../..");
const issuesRoot = path.join(portalSrc, "app/(portal)/issues");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

const sampleIssue: AgentIssue = {
  id: "iss_12",
  org_id: "org_1",
  fingerprint: "fp_tool_timeout",
  kind: "tool_error",
  title: "tool:search timeout",
  status: "open",
  severity: "high",
  agent_id: "agent_support",
  stumble_count: 12,
  user_count: 3,
  repetition_count: 12,
  first_seen: "2026-07-21T10:00:00Z",
  last_seen: "2026-07-22T08:00:00Z",
};

const sampleStumble: AgentStumble = {
  id: "stb_1",
  trace_id: "tr_ab12",
  span_id: "sp_9",
  kind: "timeout",
  fingerprint: "fp_tool_timeout",
  title: "tool:search timed out",
  severity: "high",
  detected_by: "detector",
};

describe("rebuild issues contract", () => {
  it("required routes and components exist", () => {
    expect(existsSync(path.join(issuesRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(issuesRoot, "[id]/page.tsx"))).toBe(true);
    expect(existsSync(path.join(issuesRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(path.join(issuesRoot, "_components/issues-toolbar.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(issuesRoot, "_components/issues-table.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(issuesRoot, "_components/issue-detail-panel.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(issuesRoot, "_components/findings-strip.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(issuesRoot, "_components/issue-detail-sheet.tsx")),
    ).toBe(true);
  });

  it("hub supports tab=open|all|incidents and issueId master-detail", () => {
    const src = readFileSync(path.join(issuesRoot, "page.tsx"), "utf8");
    expect(src).toContain("open");
    expect(src).toContain("all");
    expect(src).toContain("incidents");
    expect(src).toContain("issueId");
    expect(src).toContain("ResourcePageShell");
    expect(src).toContain("IssueDetailPanel");
    expect(src).toContain("IssueDetailSheet");
    expect(src).toContain("agentIssuesApi.list");
    expect(src).toContain("agentIssuesApi.get");
    expect(src).toContain("agentIssuesApi.stumbles");
    expect(src).toContain("agentIssuesApi.resolve");
    expect(src).toContain("agentIssuesApi.triage");
  });

  it("maps API fields to surface contracts", () => {
    const row = mapIssue(sampleIssue);
    expect(row.issueId).toBe("iss_12");
    expect(row.occurrenceCount).toBe(12);
    expect(row.agentId).toBe("agent_support");

    const finding = mapStumbleToFinding(sampleStumble);
    expect(finding.findingId).toBe("stb_1");
    expect(finding.traceId).toBe("tr_ab12");
    expect(finding.spanId).toBe("sp_9");
    expect(finding.message).toBe("tool:search timed out");

    expect(parseIssuesTab(undefined)).toBe("open");
    expect(parseIssuesTab("incidents")).toBe("incidents");
    expect(isIncidentCluster(row)).toBe(true);
  });

  it("C3 Open Trace is one click and preserves observe filters", () => {
    const from = new URLSearchParams({
      pastHours: "24",
      q: "timeout",
      agentId: "agent_support",
      viewId: "drop-me",
      issueId: "iss_12",
    });
    const href = buildOpenTraceHref(from, "tr_ab12", "sp_9");
    expect(href.startsWith("/traces?")).toBe(true);
    const params = new URLSearchParams(href.slice("/traces?".length));
    expect(params.get("traceId")).toBe("tr_ab12");
    expect(params.get("spanId")).toBe("sp_9");
    expect(params.get("pastHours")).toBe("24");
    expect(params.get("q")).toBe("timeout");
    expect(params.get("agentId")).toBe("agent_support");
    expect(params.get("issueId")).toBeNull();

    const panel = readFileSync(
      path.join(issuesRoot, "_components/issue-detail-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("buildOpenTraceHref");
    expect(panel).toContain("issue-open-trace");
    expect(panel).not.toContain("TraceViewerModal");
  });

  it("C4 Create Plan ≤2 clicks with honest not-enough-evidence", () => {
    const thin = hasPlanEvidence([]);
    expect(thin).toBe(false);
    const rich = hasPlanEvidence([mapStumbleToFinding(sampleStumble)]);
    expect(rich).toBe(true);

    const href = buildCreatePlanHref("iss_12", [
      mapStumbleToFinding(sampleStumble),
    ]);
    expect(href.startsWith("/improve?")).toBe(true);
    const params = new URLSearchParams(href.slice("/improve?".length));
    expect(params.get("issueId")).toBe("iss_12");
    expect(params.get("traceId")).toBe("tr_ab12");
    expect(params.get("evidence")).toContain("tr_ab12");

    const panel = readFileSync(
      path.join(issuesRoot, "_components/issue-detail-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("buildCreatePlanHref");
    expect(panel).toContain("notEnoughEvidence");
    expect(panel).toContain("issue-not-enough-evidence");
  });

  it("Findings strip maps stumbles; Assign hidden; no red-team", () => {
    const findings = readFileSync(
      path.join(issuesRoot, "_components/findings-strip.tsx"),
      "utf8",
    );
    expect(findings).toContain("FindingsStrip");
    expect(findings).toContain("buildTraceHref");

    const files = walkTs(issuesRoot);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/red-?team/i);
      expect(src).not.toContain("TraceViewerModal");
      expect(src).not.toContain("onAssign");
      expect(src).not.toMatch(/Assign\b/);
    }
  });

  it("incidents is a tab only; next.config redirects /incidents", () => {
    const page = readFileSync(path.join(issuesRoot, "page.tsx"), "utf8");
    expect(page).toContain('"incidents"');
    expect(page).not.toMatch(/href=["']\/incidents/);

    const cfg = readFileSync(nextConfig, "utf8");
    expect(cfg).toMatch(/source: ["']\/incidents["']/);
    expect(cfg).toMatch(/destination: ["']\/issues\?tab=incidents["']/);
  });

  it("i18n issues namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      issues?: { title?: string; detail?: { notEnoughEvidence?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      issues?: { title?: string; detail?: { notEnoughEvidence?: string } };
    };
    expect(en.issues?.title).toBeTruthy();
    expect(de.issues?.title).toBeTruthy();
    expect(en.issues?.detail?.notEnoughEvidence).toMatch(/Not enough evidence/i);
    expect(de.issues?.detail?.notEnoughEvidence).toBeTruthy();
  });

  it("uses shell ResourcePageShell not portal-os CoreResourcePage", () => {
    const page = readFileSync(path.join(issuesRoot, "page.tsx"), "utf8");
    expect(page).toContain('@/components/shell/resource-page-shell');
    expect(page).not.toContain("CoreResourcePage");
    expect(page).not.toContain("portal-os");
  });
});
