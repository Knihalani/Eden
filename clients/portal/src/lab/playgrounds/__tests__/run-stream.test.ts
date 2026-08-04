import { describe, expect, it } from "vitest";

import {
  cellKey,
  createSseParser,
  initialRunState,
  reduceRunEvent,
  type PlaygroundStreamEvent,
} from "../run-stream";

describe("createSseParser", () => {
  it("parses a complete data event", () => {
    const parser = createSseParser();
    const events = parser.feed('data: {"type":"start"}\n\n');
    expect(events).toEqual([{ type: "start" }]);
  });

  it("buffers events split across chunks", () => {
    const parser = createSseParser();
    expect(parser.feed('data: {"type":"cell","task_id":"a",')).toEqual([]);
    const events = parser.feed('"row_index":0,"status":"done","output":"hi"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "cell", task_id: "a", output: "hi" });
  });

  it("handles multiple events in one chunk and CRLF separators", () => {
    const parser = createSseParser();
    const events = parser.feed(
      'data: {"type":"start"}\r\n\r\ndata: {"type":"done","run_id":"r1"}\r\n\r\n',
    );
    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
  });

  it("joins multi-line data fields per SSE spec", () => {
    const parser = createSseParser();
    // JSON split across two data: lines — spec joins with \n, which is
    // whitespace-legal inside a JSON object.
    const events = parser.feed('data: {"type":"done",\ndata: "run_id":"r9"}\n\n');
    expect(events).toEqual([{ type: "done", run_id: "r9" }]);
  });

  it("ignores comments, unknown event types, [DONE], and junk", () => {
    const parser = createSseParser();
    const events = parser.feed(
      ': keepalive\n\ndata: [DONE]\n\ndata: {"type":"mystery"}\n\ndata: not json\n\n',
    );
    expect(events).toEqual([]);
  });

  it("flush() recovers a trailing block without a final blank line", () => {
    const parser = createSseParser();
    expect(parser.feed('data: {"type":"done","run_id":"r2"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: "done", run_id: "r2" }]);
    expect(parser.flush()).toEqual([]);
  });
});

describe("reduceRunEvent", () => {
  const cell = (over: Partial<PlaygroundStreamEvent & { type: "cell" }>) =>
    ({
      type: "cell",
      task_id: "base",
      row_index: 0,
      status: "running",
      ...over,
    }) as PlaygroundStreamEvent;

  it("start moves phase to streaming", () => {
    const next = reduceRunEvent(initialRunState(), { type: "start" });
    expect(next.phase).toBe("streaming");
  });

  it("fills cells progressively and keeps prior output when absent", () => {
    let state = reduceRunEvent(initialRunState(), { type: "start" });
    state = reduceRunEvent(state, cell({ output: "Hel" }));
    state = reduceRunEvent(state, cell({ output: "Hello" }));
    state = reduceRunEvent(
      state,
      cell({ status: "done", score: 0.9, latency_ms: 812, cost_usd: 0.002 }),
    );
    const c = state.cells[cellKey("base", 0)];
    expect(c.status).toBe("done");
    expect(c.output).toBe("Hello");
    expect(c.score).toBe(0.9);
    expect(c.latencyMs).toBe(812);
    expect(c.costUsd).toBe(0.002);
    expect(c.error).toBeNull();
  });

  it("keeps cells independent across tasks and rows", () => {
    let state = initialRunState();
    state = reduceRunEvent(state, cell({ output: "a0", status: "done" }));
    state = reduceRunEvent(
      state,
      cell({ task_id: "cmp", row_index: 1, output: "b1", status: "done" }),
    );
    expect(state.cells[cellKey("base", 0)].output).toBe("a0");
    expect(state.cells[cellKey("cmp", 1)].output).toBe("b1");
    expect(Object.keys(state.cells)).toHaveLength(2);
  });

  it("records per-cell errors without ending the run", () => {
    let state = reduceRunEvent(initialRunState(), { type: "start" });
    state = reduceRunEvent(
      state,
      cell({ status: "error", error: "provider timeout" }),
    );
    expect(state.phase).toBe("streaming");
    const c = state.cells[cellKey("base", 0)];
    expect(c.status).toBe("error");
    expect(c.error).toBe("provider timeout");
  });

  it("done captures run_id and totals and does not mutate input", () => {
    const start = reduceRunEvent(initialRunState(), { type: "start" });
    const done = reduceRunEvent(start, {
      type: "done",
      run_id: "run-1",
      totals: { cost_usd: 0.01 },
    });
    expect(done.phase).toBe("done");
    expect(done.runId).toBe("run-1");
    expect(done.totals).toEqual({ cost_usd: 0.01 });
    expect(start.phase).toBe("streaming");
    expect(start.runId).toBeNull();
  });
});
