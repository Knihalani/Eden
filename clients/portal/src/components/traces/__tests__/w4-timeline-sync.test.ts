/**
 * Observe V3 Wave 4 — Timeline sync (part A) source contracts.
 * Bidirectional Gantt ↔ transcript, strip above transcript, zoom/brush, span_id.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W4 timeline sync wiring", () => {
  it("TraceViewer resolves steps with span_id enrichment", () => {
    const data = src("components/trace-viewer/use-trace-viewer-data.ts");
    const viewer = src("components/trace-viewer/TraceViewer.tsx");
    expect(data).toContain("resolveTimelineSteps");
    expect(viewer).toContain("selectedSpanId={selection.selectedSpanId}");
    expect(viewer).toContain("onSpanSelect={(id) => selection.selectSpan(id)}");
    expect(viewer).toContain('initialMode = "transcript"');
  });

  it("transcript mode exposes collapsed Gantt strip toggle (option A)", () => {
    const canvas = src("components/trace-viewer/canvases/TranscriptCanvas.tsx");
    const viewer = src("components/trace-viewer/TraceViewer.tsx");
    expect(canvas).toContain('data-testid="transcript-gantt-strip"');
    expect(canvas).toContain('data-testid="transcript-gantt-toggle"');
    expect(viewer).toContain("ganttStripOpen");
    expect(canvas).toContain('variant="strip"');
    expect(canvas).toContain("Timeline overview");
  });

  it("TraceTimelineView supports zoom, brush, error tint, strip variant", () => {
    const views = src("components/traces/trace-detail-views.tsx");
    expect(views).toContain("timeline-zoom-in");
    expect(views).toContain("timeline-zoom-out");
    expect(views).toContain("timeline-brush-track");
    expect(views).toContain('bg-[var(--error)]');
    expect(views).toContain('variant?: "full" | "strip"');
    expect(views).toContain("zoomWindow");
    expect(views).toContain("brushToWindow");
  });

  it("TranscriptV2 still syncs highlightSpanId ↔ onSpanSelect", () => {
    const v2 = src("components/transcript-v2/TranscriptV2.tsx");
    expect(v2).toContain("highlightSpanId");
    expect(v2).toContain("onSpanSelect?.(spanId)");
    expect(v2).toContain(`[data-span-id=`);
  });
});
