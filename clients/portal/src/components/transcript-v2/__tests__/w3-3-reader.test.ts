/**
 * Observe V3 Wave 3 — Trace reader / inspector (part A).
 * Source contracts: metadata pills, Formatted↔JSON, spanId write-back,
 * failure callout, SpanDetailSidebar on hub path, subagent 1-line preview.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W3.3 metadata pill strip", () => {
  it("TraceDetailPanel context pills cover model · latency · tokens · cost · session", () => {
    const panel = src("components/traces/TraceDetailPanel.tsx");
    expect(panel).toContain('data-testid="trace-context-pills"');
    expect(panel).toContain('data-pill="latency"');
    expect(panel).toContain('data-pill="tokens"');
    expect(panel).toContain('data-pill="cost"');
    expect(panel).toContain('data-pill="session"');
    expect(panel).toContain("TraceHeader");
  });
});

describe("W3.3 Formatted ↔ JSON I/O", () => {
  it("MessagesPanel and ResponsePanel expose IoFormatToggle", () => {
    const a = src("components/transcript-v2/transcript-panels-a.tsx");
    const b = src("components/transcript-v2/transcript-panels-b.tsx");
    expect(a).toContain("IoFormatToggle");
    expect(a).toContain("Formatted");
    expect(a).toContain('"json"');
    expect(a).toContain('id="io-format-toggle-input"');
    expect(b).toContain("IoFormatToggle");
    expect(b).toContain('id="io-format-toggle-output"');
    expect(b).toContain("viewMode === \"json\"");
  });
});

describe("W3.3 persistent span I/O inspector + spanId write-back", () => {
  it("TranscriptV2 mounts SpanDetailSidebar closed until selection", () => {
    const v2 = src("components/transcript-v2/TranscriptV2.tsx");
    expect(v2).toContain("SpanDetailSidebar");
    expect(v2).toContain("inspectorSpanId");
    expect(v2).toContain("highlightSpanId ?? null");
    expect(v2).toContain("onSpanSelect");
    expect(v2).toContain("handleCloseInspector");
  });

  it("SpanDetailSidebar shows Input/Output with close control", () => {
    const chrome = src("components/transcript-v2/transcript-reader-chrome.tsx");
    expect(chrome).toContain('data-testid="span-detail-sidebar"');
    expect(chrome).toContain('data-testid="span-inspector-close"');
    expect(chrome).toContain('title="Input"');
    expect(chrome).toContain("ResponsePanel");
    expect(chrome).toContain('layout?: "default" | "fullscreen"');
    expect(chrome).toContain("min-w-[360px]");
  });

  it("hub wires onSpanSelect → handleSelectSpan → ?spanId=", () => {
    const page = src("app/(portal)/traces/page.tsx");
    const hub = src("app/(portal)/traces/_components/use-traces-hub.ts");
    const panel = src("components/traces/TraceDetailPanel.tsx");
    expect(panel).toContain("onSpanSelect?: (spanId: string | null) => void");
    expect(panel).toContain("onSpanSelect={onSpanSelect}");
    expect(page).toContain("onSpanSelect={hub.handleSelectSpan}");
    expect(hub).toContain("handleSelectSpan");
    expect(hub).toContain("spanId: nextSpanId || undefined");
  });
});

describe("W3.3 failure callout + subagent preview", () => {
  it("failure callout sits above transcript with Issues link", () => {
    const panel = src("components/traces/TraceDetailPanel.tsx");
    expect(panel).toContain('data-testid="trace-failure-callout"');
    expect(panel).toContain("View related issues");
    expect(panel).toContain("/issues?");
    expect(panel).not.toContain("sticky top-0 z-20"); // soft, not third sticky band
  });

  it("SubagentGroup uses 1-line In/Out preview", () => {
    const sg = src("components/transcript-v2/SubagentGroup.tsx");
    expect(sg).toContain("previewLines={1}");
    expect(sg).toContain("useState(false)");
  });
});
