/**
 * Wave 2 — Trace reading overhaul contracts (Laminar numeric + single stack).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifySpanKind,
  spanKindColor,
} from "../span-kind";
import {
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_ROW_ESTIMATE_EXPANDED,
} from "../VirtualTranscript";
import { MESSAGE_CARD_MAX_PX } from "../MessageCards";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W2 transcript stack merge", () => {
  it("observability TranscriptView is a thin re-export of transcript-v2", () => {
    const tv = src("components/observability/TranscriptView.tsx");
    expect(tv).toContain("transcript-v2/TranscriptReader");
    expect(tv.split("\n").length).toBeLessThan(20);
    expect(tv).not.toContain("SummaryCard");
  });

  it("canonical reader + row modules live under transcript-v2", () => {
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/TranscriptReader.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/TranscriptRowItem.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/SubagentGroup.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/VirtualTranscript.tsx"))).toBe(true);
  });
});

describe("W2 Laminar numeric contracts", () => {
  it("row estimates are 182 / 198", () => {
    expect(TRANSCRIPT_ROW_ESTIMATE).toBe(182);
    expect(TRANSCRIPT_ROW_ESTIMATE_EXPANDED).toBe(198);
  });

  it("MessageCard clamp is 360px", () => {
    expect(MESSAGE_CARD_MAX_PX).toBe(360);
    const cards = src("components/transcript-v2/MessageCards.tsx");
    expect(cards).toContain("max-h-[360px]");
    expect(cards).toContain('data-testid="message-card-expand-strip"');
  });

  it("CollapsedTextWithMore defaults to 4-line clamp + stopPropagation", () => {
    const clamp = src("components/transcript-v2/CollapsedTextWithMore.tsx");
    expect(clamp).toContain("lines = 4");
    expect(clamp).toContain("line-clamp-4");
    expect(clamp).toContain("stopPropagation");
  });

  it("TraceSplitLayout panel min 400 and stack <800", () => {
    const split = src("components/traces/TraceSplitLayout.tsx");
    expect(split).toContain("panelMinPx = 400");
    expect(split).toContain("stackBelowPx = 800");
    expect(split).toContain('data-testid="trace-split-resize"');
    expect(split).toContain("ResizeObserver");
  });
});

describe("W2 span kinds + subagent collapse", () => {
  it("classifies llm/tool/subagent/error only (semantic colors, no purple)", () => {
    expect(classifySpanKind({ outcome: "error" })).toBe("error");
    expect(classifySpanKind({ is_subagent: true })).toBe("subagent");
    expect(classifySpanKind({ event_type: "tool", tool_calls: [{}] })).toBe("tool");
    expect(classifySpanKind({ event_type: "llm.chat", request_body: {} })).toBe("llm");
    expect(spanKindColor("llm")).toBe("var(--accent)");
    expect(spanKindColor("tool")).toBe("var(--warning)");
    expect(spanKindColor("subagent")).toBe("var(--info)");
    expect(spanKindColor("error")).toBe("var(--error)");
    expect(spanKindColor("llm")).not.toContain("purple");
  });

  it("SubagentGroup defaults collapsed with In/Out preview + sticky expand", () => {
    const sg = src("components/transcript-v2/SubagentGroup.tsx");
    expect(sg).toContain("useState(false)");
    expect(sg).toContain("CollapsedTextWithMore");
    expect(sg).toContain("previewLines={1}");
    expect(sg).toContain("sticky top-0");
    expect(sg).toContain('data-testid="subagent-group"');
  });

  it("TranscriptRowItem uses SpanKindPill / SubagentGroup", () => {
    const row = src("components/transcript-v2/TranscriptRowItem.tsx");
    expect(row).toContain("SpanKindPill");
    expect(row).toContain("SubagentGroup");
    expect(row).toContain("classifySpanKind");
    expect(row).not.toContain("accent-purple");
  });
});

describe("W2 detail chrome", () => {
  it("TraceViewer uses Z0/Z1 chrome + metrics + overflow (no dual headers)", () => {
    const viewer = src("components/trace-viewer/TraceViewer.tsx");
    expect(viewer).toContain("TraceViewerChrome");
    expect(viewer).toContain("TraceViewerToolbar");
    expect(viewer).toContain("TranscriptCanvas");
    expect(viewer).not.toContain("TraceHeader");
    const toolbar = src("components/trace-viewer/TraceViewerToolbar.tsx");
    expect(toolbar).toContain('data-testid="trace-actions-overflow"');
    expect(toolbar).toContain('data-testid="trace-header-metrics"');
    const chrome = src("components/trace-viewer/TraceViewerChrome.tsx");
    expect(chrome).toContain('data-testid="trace-viewer-chrome"');
  });

  it("TranscriptV2 uses TanStack VirtualTranscript + hideSummary", () => {
    const v2 = src("components/transcript-v2/TranscriptV2.tsx");
    expect(v2).toContain("VirtualTranscript");
    expect(v2).toContain("TRANSCRIPT_ROW_ESTIMATE");
    expect(v2).toContain("hideSummary");
    const virt = src("components/transcript-v2/VirtualTranscript.tsx");
    expect(virt).toContain("@tanstack/react-virtual");
    expect(virt).toContain("useVirtualizer");
  });

  it("traces hub wires TraceViewer (no modal+panel wrap)", () => {
    const page = src("app/(portal)/traces/page.tsx");
    expect(page).toContain("TraceViewer");
    expect(page).not.toContain("TraceViewerModal");
    expect(page).not.toContain('layout="fullscreen"');
    expect(page).toContain("hub.handleCloseDetail");
    expect(page).not.toContain("TraceSplitLayout");
  });
});
