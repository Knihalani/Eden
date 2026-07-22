import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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

const listJudgeScores = vi.fn();
const runJudges = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    listJudgeScores: (...args: unknown[]) => listJudgeScores(...args),
    runJudges: (...args: unknown[]) => runJudges(...args),
  },
}));

import { TraceViewer } from "../TraceViewer";

describe("TraceViewer", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    listJudgeScores.mockReset();
    runJudges.mockReset();
    listJudgeScores.mockResolvedValue({ scores: [], next_cursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders dialog with single unified top bar when open", () => {
    render(
      <TraceViewer open onClose={vi.fn()} traceId="tr_abc123" title="Agent X" outcome="success" />,
    );
    expect(screen.getByTestId("trace-viewer")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("trace-viewer-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("span-nav-tree")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-header")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("trace-viewer-topbar")).toHaveLength(1);
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
    // tree alias → Transcript + span nav
    expect(screen.getByTestId("transcript-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("span-nav-tree")).toBeInTheDocument();
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
    expect(screen.queryByRole("tab", { name: "Tree" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Scores" })).toBeInTheDocument();
  });

  it("scores mode shows scores-canvas and leaves loading after API resolve", async () => {
    listJudgeScores.mockResolvedValue({
      scores: [
        {
          judge_run_id: "jr_1",
          trace_id: "tr_scores",
          judge_name: "correctness",
          judge_version: "v1",
          score: 0.9,
          rationale: "ok",
          model: "gpt-4o",
          scored_at: "2026-01-01T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    render(
      <TraceViewer
        open
        onClose={vi.fn()}
        traceId="tr_scores"
        initialMode="scores"
      />,
    );
    expect(screen.getByTestId("scores-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-canvas")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("scores-canvas-loading")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("scores-canvas-list")).toBeInTheDocument();
    expect(listJudgeScores).toHaveBeenCalled();
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
