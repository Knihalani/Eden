/**
 * Wave 27 — N11 live streaming + F21 tool labels (portal contracts).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");
const sdk = (rel: string) =>
  readFileSync(resolve(ROOT, "../../sdk/python", rel), "utf8");
const docs = (rel: string) =>
  readFileSync(resolve(ROOT, "../../docs", rel), "utf8");

describe("W27 N11 live streaming", () => {
  it("ships Redis live publisher/subscriber + routes", () => {
    expect(
      existsSync(resolve(ROOT, "../../src/eden/observability/live/publisher.py")),
    ).toBe(true);
    expect(
      existsSync(resolve(ROOT, "../../src/eden/observability/live/subscriber.py")),
    ).toBe(true);
    const route = py("eden/api/routes/observability_live.py");
    expect(route).toContain("/{session_id}/publish");
    expect(route).toContain("/{session_id}/events");
    expect(route).toContain("/{session_id}/finalize");
    expect(route).toContain("live_trace_streaming_v1");
    expect(route).toContain("get_ingest_auth");
    expect(route).toContain("require_path_org_access");
  });

  it("registers feature flags", () => {
    const cfg = py("eden/config.py");
    expect(cfg).toContain("live_trace_streaming_v1");
    expect(cfg).toContain("live_mcp_tail_v1");
    expect(cfg).toContain("live_max_sessions_per_org");
    expect(cfg).toContain("tool_call_inference_v1");
  });

  it("SDK exposes stream=True and EDEN_LIVE", () => {
    const live = sdk("eden_sdk/live.py");
    expect(live).toContain("EDEN_LIVE");
    expect(live).toContain("live_mode_enabled");
    const trace = sdk("eden_sdk/trace.py");
    expect(trace).toContain("stream: bool | None = None");
    expect(trace).toContain("emit_span_live");
  });

  it("portal Live badge + session SSE hook", () => {
    const data = src("components/trace-viewer/use-trace-viewer-data.ts");
    const topbar = src("components/trace-viewer/UnifiedTopBar.tsx");
    expect(topbar).toContain("live-trace-badge");
    expect(data).toContain("useLiveTraceStream");
    expect(topbar).toContain("Live");
    expect(existsSync(resolve(ROOT, "src/hooks/use-live-trace-stream.ts"))).toBe(
      true,
    );
    const hook = src("hooks/use-live-trace-stream.ts");
    expect(hook).toContain("stream/traces/");
    expect(hook).toContain("/events");
    expect(hook).toContain("MAX_RECONNECT_ATTEMPTS");
    expect(hook).toContain("retry");
    expect(topbar).toContain("live-trace-retry");
    expect(data).toContain('searchParams.get("live") === "1"');
    expect(data).toContain("outcomeInFlight");
    expect(data).not.toContain("sessionId ?? traceId");
    expect(data).toMatch(/sessionId,\s*\n\s*enabled:/);
  });

  it("MCP tail_trace registered", () => {
    const server = py("eden/mcp_server/server.py");
    expect(server).toContain('"tail_trace"');
    expect(server).toContain("tool_fns.tail_trace");
    const tools = py("eden/mcp_server/tools.py");
    expect(tools).toContain("async def tail_trace");
  });

  it("ChatSidebar tail_live_trace tool", () => {
    const insights = py("eden/llmops/insights_tools.py");
    expect(insights).toContain('name="tail_live_trace"');
    expect(insights).toContain("async def tail_live_trace");
  });
});

describe("W27 F21 tool labels", () => {
  it("MessageCards + ParallelToolLane expose label buttons", () => {
    const cards = src("components/transcript-v2/MessageCards.tsx");
    expect(cards).toContain("f21-tool-labels");
    expect(cards).toContain("labelToolCall");
    const lane = src("components/transcript-v2/ParallelToolLane.tsx");
    expect(lane).toContain("f21-tool-labels");
    expect(lane).toContain("labelToolCall");
  });

  it("calibrator + migration + MCP label_tool_call", () => {
    expect(
      existsSync(
        resolve(ROOT, "../../src/eden/learning/tool_call_calibrator.py"),
      ),
    ).toBe(true);
    const mig = py("eden/db_migrations/versions/111_w27_live_labels.py");
    expect(mig).toContain('down_revision: str = "110_w26_drop_issue_fix_sessions"');
    expect(mig).toContain("tool_call_calibrators");
    const mcp = py("eden/mcp_server/server.py");
    expect(mcp).toContain('"label_tool_call"');
  });

  it("stamps N11/F21 honesty in tracker + checklist", () => {
    const tracker = docs("specs/SOTA-WAVE-TRACKER.md");
    expect(tracker).toMatch(/W27.*GREEN|GREEN.*W27/i);
    const checklist = docs("specs/GA-COMPLETION-CHECKLIST.md");
    expect(checklist).toMatch(/N11.*DONE|DONE.*N11/i);
    expect(checklist).toMatch(/F21.*DONE|DONE.*F21/i);
  });
});
