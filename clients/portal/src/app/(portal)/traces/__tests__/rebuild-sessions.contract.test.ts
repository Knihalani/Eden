/**
 * Phase 3 Sessions lens contract — surfaces/sessions.md acceptance.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = path.resolve(__dirname, "../../../..");
const tracesRoot = path.join(portalSrc, "app/(portal)/traces");
const hooksRoot = path.join(portalSrc, "app/(portal)/_hooks");
const sessionsRoot = path.join(portalSrc, "app/(portal)/sessions");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("rebuild sessions contract", () => {
  it("canonical home is /traces?view=sessions", () => {
    const page = read(path.join(tracesRoot, "page.tsx"));
    expect(page).toContain('"sessions"');
    expect(page).toContain("SessionsMasterTable");
    expect(page).toContain("view: \"sessions\"");

    const panel = read(path.join(tracesRoot, "_components/detail-panel.tsx"));
    expect(panel).toContain("SessionReader");

    const sessionsPage = read(path.join(sessionsRoot, "page.tsx"));
    expect(sessionsPage).toMatch(/redirect\(["']\/traces\?view=sessions["']\)/);
  });

  it("preserves sessionId when opening child traceId", () => {
    const page = read(path.join(tracesRoot, "page.tsx"));
    expect(page).toContain("onSelectTurn");
    expect(page).toContain("onOpenTranscript");
    expect(page).toMatch(/sessionId:\s*state\.sessionId/);

    const panel = read(path.join(tracesRoot, "_components/detail-panel.tsx"));
    expect(panel).toContain("sessionId");
    expect(panel).toContain("SessionReader");
  });

  it("session reader shows turn timeline with metrics", () => {
    const reader = read(
      path.join(tracesRoot, "_components/session-reader.tsx"),
    );
    expect(reader).toContain("session-turn-timeline");
    expect(reader).toContain("MetricInline");
    expect(reader).toContain("formatLatency");
    expect(reader).toContain("formatTokens");
    expect(reader).toContain("formatCost");
    expect(reader).toContain("DiagnosisStrip");
    expect(reader).toContain("zeroTurns");
    expect(reader).toContain("issueHref");
    expect(reader).toContain("createIssue");

    const hook = read(path.join(hooksRoot, "use-session-detail.ts"));
    expect(hook).toContain("/issues");
  });

  it("sessions master table uses aggregate metrics", () => {
    const table = read(
      path.join(tracesRoot, "_components/sessions-master-table.tsx"),
    );
    expect(table).toContain("MetricInline");
    expect(table).toContain("turnCount");
    expect(table).toContain("sessions-master-table");
  });

  it("use-session-detail wires agentSessionsApi", () => {
    const hook = read(path.join(hooksRoot, "use-session-detail.ts"));
    expect(hook).toContain("agentSessionsApi.get");
    expect(hook).toContain("listObservabilityTraces");
    expect(hook).toContain("queryKeys.agents.session");
  });

  it("progressive Esc uses escClear / observe-url", () => {
    const page = read(path.join(tracesRoot, "page.tsx"));
    expect(page).toContain("escClear");
    expect(page).toContain("onClose={escClear}");

    const observeUrl = read(path.join(portalSrc, "lib/observe-url.ts"));
    expect(observeUrl).toContain("progressiveEscClear");
    expect(observeUrl).toContain('level === "span"');
    expect(observeUrl).toContain('level === "trace"');
    expect(observeUrl).toContain('level === "session"');
  });

  it("/sessions/[id] redirects with sessionId preserved", () => {
    const idPage = read(path.join(sessionsRoot, "[sessionId]/page.tsx"));
    expect(idPage).toContain("view=sessions");
    expect(idPage).toContain("sessionId=");
    expect(idPage).toContain("encodeURIComponent(sessionId)");
  });

  it("no standalone Sessions product shell components", () => {
    expect(existsSync(path.join(sessionsRoot, "_components"))).toBe(false);
    const sessionsPage = read(path.join(sessionsRoot, "page.tsx"));
    expect(sessionsPage).not.toContain("ResourcePageShell");
    expect(sessionsPage).not.toContain("PageHeader");
  });
});
