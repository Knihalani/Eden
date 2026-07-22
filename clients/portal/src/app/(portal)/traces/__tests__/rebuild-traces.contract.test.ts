/**
 * Phase 3 Traces contract — surfaces/traces.md acceptance.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = path.resolve(__dirname, "../../../..");
const tracesRoot = path.join(portalSrc, "app/(portal)/traces");
const hooksRoot = path.join(portalSrc, "app/(portal)/_hooks");
const sessionsRoot = path.join(portalSrc, "app/(portal)/sessions");
const messagesEn = path.join(portalSrc, "messages/en.json");
const messagesDe = path.join(portalSrc, "messages/de.json");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("rebuild traces contract", () => {
  it("required routes and components exist", () => {
    expect(existsSync(path.join(tracesRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(tracesRoot, "loading.tsx"))).toBe(true);

    const components = [
      "traces-toolbar.tsx",
      "traces-master-table.tsx",
      "spans-master-table.tsx",
      "sessions-master-table.tsx",
      "detail-panel.tsx",
      "mode-tabs.tsx",
      "transcript-canvas.tsx",
      "transcript-step-row.tsx",
      "tree-canvas.tsx",
      "timeline-canvas.tsx",
      "meta-canvas.tsx",
      "scores-canvas.tsx",
      "session-reader.tsx",
      "trace-detail-sheet.tsx",
    ];
    for (const c of components) {
      expect(existsSync(path.join(tracesRoot, "_components", c))).toBe(true);
    }
  });

  it("hooks wire observability + sessions APIs", () => {
    const hub = read(path.join(hooksRoot, "use-traces-hub-data.ts"));
    expect(hub).toContain("listObservabilityTraces");
    expect(hub).toContain("agentSessionsApi");
    expect(hub).toContain("useObservabilityStream");
    expect(hub).toContain("queryKeys");

    const detail = read(path.join(hooksRoot, "use-trace-detail.ts"));
    expect(detail).toContain("getTraceTree");
    expect(detail).toContain("getTraceTimeline");
    expect(detail).toContain("getTraceSummary");
    expect(detail).toContain("listJudgeScores");

    expect(existsSync(path.join(hooksRoot, "use-session-detail.ts"))).toBe(
      true,
    );
  });

  it("defaults view=traces and mode=transcript when traceId set", () => {
    const page = read(path.join(tracesRoot, "page.tsx"));
    expect(page).toContain('mode: state.mode ?? "transcript"');
    expect(page).toContain("useObserveUrlState");
    expect(page).toContain("ResourcePageShell");
    expect(page).toContain("TraceDetailPanel");
  });

  it("ships all five reader modes", () => {
    const modes = read(
      path.join(tracesRoot, "_components/mode-tabs.tsx"),
    );
    expect(modes).toContain("OBSERVE_MODES");
    expect(modes).toContain("data-mode={m}");
    expect(modes).toContain('useTranslations("traces.modes")');

    const observeUrl = read(path.join(portalSrc, "lib/observe-url.ts"));
    for (const m of ["transcript", "tree", "timeline", "meta", "scores"]) {
      expect(observeUrl).toContain(`"${m}"`);
    }

    const panel = read(path.join(tracesRoot, "_components/detail-panel.tsx"));
    expect(panel).toContain("TranscriptCanvas");
    expect(panel).toContain("TreeCanvas");
    expect(panel).toContain("TimelineCanvas");
    expect(panel).toContain("MetaCanvas");
    expect(panel).toContain("ScoresCanvas");
    expect(panel).toContain("DiagnosisStrip");
  });

  it("uses MetricInline and no card-per-step / TraceViewerModal", () => {
    const master = read(
      path.join(tracesRoot, "_components/traces-master-table.tsx"),
    );
    expect(master).toContain("MetricInline");
    expect(master).toContain("formatLatency");
    expect(master).toContain("formatTokens");
    expect(master).toContain("formatCost");

    const step = read(
      path.join(tracesRoot, "_components/transcript-step-row.tsx"),
    );
    expect(step).toContain("MetricInline");
    expect(step).toContain("bg-[var(--bg-inset)]");
    expect(step).not.toMatch(/<Card[\s>]/);

    const page = read(path.join(tracesRoot, "page.tsx"));
    expect(page).not.toContain("TraceViewerModal");
    expect(page).not.toContain("EmbeddedSurface");
  });

  it("detail uses DetailPanelShell mobileDrawer for Sheet <1280", () => {
    const panel = read(path.join(tracesRoot, "_components/detail-panel.tsx"));
    expect(panel).toContain("DetailPanelShell");
    expect(panel).toContain("mobileDrawer");
    expect(
      existsSync(path.join(tracesRoot, "_components/trace-detail-sheet.tsx")),
    ).toBe(true);
  });

  it("live is opt-in via live=1 / Display toggle", () => {
    const toolbar = read(
      path.join(tracesRoot, "_components/traces-toolbar.tsx"),
    );
    expect(toolbar).toContain("traces-live-toggle");
    expect(toolbar).toContain("onLiveChange");

    const hub = read(path.join(hooksRoot, "use-traces-hub-data.ts"));
    expect(hub).toMatch(/live === ["']1["']/);
    expect(hub).toContain("enabled: Boolean(orgId) && live");
  });

  it("Create Issue exits to /issues with evidence params", () => {
    const panel = read(path.join(tracesRoot, "_components/detail-panel.tsx"));
    expect(panel).toContain("/issues?");
    expect(panel).toContain("traceId");
    expect(panel).toContain("trace-create-issue");
    expect(panel).toContain("/debugger");
    expect(panel).not.toContain("/_stub/debugger");
    expect(panel).toContain("/improve");
    expect(panel).toContain("AddToDatasetDialog");
    expect(panel).toContain("trace-add-to-dataset");
    expect(panel).not.toContain("/_stub/evals");
  });

  it("sessions redirects exist; no parallel product page", () => {
    const sessionsPage = read(path.join(sessionsRoot, "page.tsx"));
    expect(sessionsPage).toContain('redirect("/traces?view=sessions")');

    const sessionIdPage = read(
      path.join(sessionsRoot, "[sessionId]/page.tsx"),
    );
    expect(sessionIdPage).toContain("view=sessions");
    expect(sessionIdPage).toContain("sessionId=");
    expect(sessionIdPage).toContain("redirect");
  });

  it("i18n namespaces traces and sessions exist in en and de", () => {
    const en = JSON.parse(read(messagesEn)) as Record<string, unknown>;
    const de = JSON.parse(read(messagesDe)) as Record<string, unknown>;
    expect(en.traces).toBeTruthy();
    expect(en.sessions).toBeTruthy();
    expect(de.traces).toBeTruthy();
    expect(de.sessions).toBeTruthy();
  });
});
