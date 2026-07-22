import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as React from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("../use-trace-viewer-data", () => ({
  useTraceViewerData: () => ({
    orgId: "org_1",
    currentOrg: { id: "org_1" },
    phase: "ready",
    error: null,
    meta: {
      duration_ms: 120,
      span_count: 2,
      outcome: "success",
      model: "gpt-4o",
      cost_cents: 12,
      session_id: "sess_1",
      agent_id: "agent_1",
      input_tokens: 10,
      output_tokens: 20,
      tags: null,
    },
    rows: [
      {
        span_id: "span_a",
        name: "chat.completion",
        timestamp: "2026-01-01T00:00:00Z",
        duration_ms: 50,
        event_type: "llm",
        request_body: { messages: [{ role: "user", content: "hi" }] },
        response_body: "hello",
      },
      {
        span_id: "span_b",
        name: "tool.search",
        timestamp: "2026-01-01T00:00:01Z",
        duration_ms: 70,
        event_type: "tool",
        tool_calls: [{ type: "function", name: "search" }],
      },
    ],
    treeRows: [
      {
        span_id: "span_a",
        name: "chat.completion",
        timestamp: "2026-01-01T00:00:00Z",
        duration_ms: 50,
      },
    ],
    totalTokens: { input: 10, output: 20, total: 30 },
    sessionId: "sess_1",
    liveStream: {
      live: false,
      failed: false,
      finalized: false,
      events: [],
      retry: vi.fn(),
    },
    timelineQuery: { isLoading: false, error: null, data: { steps: [], markers: [] } },
    timelineSteps: [],
    timelineTotalMs: 120,
  }),
}));

vi.mock("@/components/transcript-v2/VirtualTranscript", () => ({
  TRANSCRIPT_ROW_ESTIMATE: 80,
  TRANSCRIPT_ROW_ESTIMATE_EXPANDED: 100,
  VirtualTranscript: ({
    items,
  }: {
    items: Array<{ key: string; content: React.ReactNode }>;
  }) => (
    <div data-testid="virtual-transcript">
      {items.map((item) => (
        <div key={item.key}>{item.content}</div>
      ))}
    </div>
  ),
}));

import { TraceViewer } from "../TraceViewer";

describe("TraceViewer", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders dialog with single Z0 chrome band when open", () => {
    render(
      <TraceViewer open onClose={vi.fn()} traceId="tr_abc123" title="Agent X" outcome="success" />,
    );
    expect(screen.getByTestId("trace-viewer")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("trace-viewer-chrome")).toBeInTheDocument();
    expect(screen.getByTestId("trace-viewer-toolbar")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-header")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("trace-viewer-chrome")).toHaveLength(1);
  });

  it("returns nothing when closed", () => {
    render(<TraceViewer open={false} onClose={vi.fn()} traceId="tr_x" />);
    expect(screen.queryByTestId("trace-viewer")).not.toBeInTheDocument();
  });

  it("calls onClose from Close control", () => {
    const onClose = vi.fn();
    render(<TraceViewer open onClose={onClose} traceId="tr_close" />);
    fireEvent.click(screen.getByTestId("trace-viewer-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("switches mode via initialMode / onModeChange sync", () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <TraceViewer
        open
        onClose={vi.fn()}
        traceId="tr_mode"
        initialMode="transcript"
        onModeChange={onModeChange}
      />,
    );
    expect(screen.getByTestId("transcript-canvas")).toBeInTheDocument();
    rerender(
      <TraceViewer
        open
        onClose={vi.fn()}
        traceId="tr_mode"
        initialMode="tree"
        onModeChange={onModeChange}
      />,
    );
    expect(screen.getByTestId("tree-canvas")).toBeInTheDocument();
    rerender(
      <TraceViewer
        open
        onClose={vi.fn()}
        traceId="tr_mode"
        initialMode="timeline"
        onModeChange={onModeChange}
      />,
    );
    expect(screen.getByTestId("timeline-canvas")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tree" })).toBeInTheDocument();
  });

  it("opens span inspector from highlightSpanId and closes with Esc first", () => {
    const onSpanSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TraceViewer
        open
        onClose={onClose}
        traceId="tr_insp"
        highlightSpanId="span_a"
        onSpanSelect={onSpanSelect}
      />,
    );
    expect(screen.getByTestId("span-inspector")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape", bubbles: true });
    expect(screen.queryByTestId("span-inspector")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wires j/k to onNext/onPrev when reader not focused", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(
      <TraceViewer
        open
        onClose={vi.fn()}
        traceId="tr_nav"
        onNext={onNext}
        onPrev={onPrev}
      />,
    );
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "k" });
    expect(onNext).toHaveBeenCalled();
    expect(onPrev).toHaveBeenCalled();
  });
});
