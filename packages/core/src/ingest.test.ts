import { describe, expect, test } from "bun:test";
import {
  parseGenericJsonl,
  parseOtelSpans,
  parseLangSmithRuns,
  parseOpenAIToolCalls,
  parseLangfuseObservations,
  detectAndParse,
} from "./ingest";
import { cutIslands } from "./islands";
import type { ToolEvent } from "./types";

/**
 * Cold-start elimination (plan §P1): observability-platform ingestion.
 * Users should get value on day 1 by importing existing trace history
 * instead of waiting for their agent to repeat patterns naturally.
 */

describe("generic JSONL", () => {
  test("parses well-formed lines into events", () => {
    const content = [
      '{"name":"search","args":{"q":"test"},"result":{"hits":3},"ok":true,"duration_ms":100}',
      '{"name":"write","args":{"path":"a.ts"},"result":{"ok":true},"ok":true}',
    ].join("\n");
    const events = parseGenericJsonl(content);
    expect(events).toHaveLength(2);
    expect(events[0]!.name).toBe("search");
    expect(events[0]!.duration_ms).toBe(100);
    expect(events[1]!.name).toBe("write");
  });

  test("skips malformed and nameless lines", () => {
    const content = [
      "not json",
      '{"args":{"q":"no name"}}',
      '{"name":"valid","args":{}}',
    ].join("\n");
    const events = parseGenericJsonl(content);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("valid");
  });
});

describe("OpenTelemetry spans", () => {
  test("extracts tool calls from GenAI attribute conventions", () => {
    const spans = [
      {
        traceId: "tr-1",
        name: "execute_tool.search",
        attributes: { "gen_ai.tool.name": "search", "gen_ai.tool.args": JSON.stringify({ q: "test" }) },
        status: { code: "STATUS_CODE_OK" },
        startTimeUnixNano: "100",
        endTimeUnixNano: "200000000",
      },
      {
        traceId: "tr-1",
        name: "llm_call.gpt4o",
        attributes: { "gen_ai.system": "openai" },
        status: { code: "STATUS_CODE_OK" },
        startTimeUnixNano: "300",
        endTimeUnixNano: "400000000",
      },
      {
        traceId: "tr-1",
        name: "execute_tool.write",
        attributes: { "tool.name": "write", "tool.args": { path: "out.ts" } },
        status: { code: "STATUS_CODE_OK" },
        startTimeUnixNano: "500",
        endTimeUnixNano: "600000000",
      },
    ];
    const traces = parseOtelSpans(spans as any[]);
    expect(traces.size).toBe(1); // one trace group
    const events = traces.get("tr-1")!;
    // LLM span skipped; two tool events extracted.
    expect(events.length).toBe(2);
    expect(events[0]!.name).toBe("search");
    expect(events[0]!.duration_ms).toBe(200);
    expect(events[1]!.name).toBe("write");
    expect(events[1]!.args).toEqual({ path: "out.ts" });
  });

  test("error spans are marked ok:false", () => {
    const spans = [
      { traceId: "t", name: "s1", attributes: { "gen_ai.tool.name": "search" }, status: { code: "STATUS_CODE_OK" }, startTimeUnixNano: "1", endTimeUnixNano: "2" },
      { traceId: "t", name: "s2", attributes: { "gen_ai.tool.name": "boom" }, status: { code: "STATUS_CODE_ERROR" }, startTimeUnixNano: "3", endTimeUnixNano: "4" },
    ];
    const traces = parseOtelSpans(spans as any[]);
    const events = traces.get("t")!;
    expect(events[1]!.ok).toBe(false);
  });

  test("single-event traces are excluded (need ≥2 to form a stretch)", () => {
    const spans = [
      { traceId: "only-one", name: "s", attributes: { "gen_ai.tool.name": "search" }, status: {}, startTimeUnixNano: "1" },
    ];
    expect(parseOtelSpans(spans as any[]).size).toBe(0);
  });
});

describe("LangSmith runs", () => {
  test("extracts tool-type runs grouped by trace_id", () => {
    const runs = [
      { id: "r1", run_type: "llm", name: "gpt-4o", inputs: {}, outputs: {} },
      { id: "r2", run_type: "tool", name: "get_issue", inputs: { issue_number: 12 }, outputs: { title: "fix" }, start_time: "2026-01-01T00:00:00Z", end_time: "2026-01-01T00:00:01Z", trace_id: "trace-a" },
      { id: "r3", run_type: "tool", name: "post_comment", inputs: { body: "done" }, outputs: { id: 99 }, start_time: "2026-01-01T00:00:02Z", end_time: "2026-01-01T00:00:03Z", error: null, trace_id: "trace-a" },
    ];
    const traces = parseLangSmithRuns(runs);
    expect(traces.size).toBe(1);
    const events = traces.get("trace-a")!;
    expect(events.map((e) => e.name)).toEqual(["get_issue", "post_comment"]);
    expect(events[0]!.result).toEqual({ title: "fix" });
  });

  test("error runs are marked ok:false", () => {
    const runs = [
      { run_type: "tool", name: "fetch", inputs: {}, error: null, start_time: "2026-01-01T00:00:00Z", trace_id: "t" },
      { run_type: "tool", name: "boom", inputs: {}, error: "timeout", start_time: "2026-01-01T00:00:01Z", trace_id: "t" },
    ];
    const traces = parseLangSmithRuns(runs);
    expect([...traces.values()][0]![1]!.ok).toBe(false);
  });
});

describe("auto-detection", () => {
  test("routes generic JSONL correctly", () => {
    const content = '{"name":"search","args":{},"ok":true}';
    const result = detectAndParse(content);
    expect(result?.format).toBe("generic_jsonl");
  });

  test("routes LangSmith array correctly", () => {
    const content = '[{"run_type":"tool","name":"x","inputs":{}}]';
    const result = detectAndParse(content);
    expect(result?.format).toBe("langsmith");
  });

  test("returns null for unrecognized content", () => {
    expect(detectAndParse("hello world")).toBeNull();
    expect(detectAndParse("[1,2,3]")).toBeNull();
  });

  test("parses OpenAI tool-call sequences from chat completion logs", () => {
    const logs = [
      {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{ id: "call_1", function: { name: "get_issue", arguments: '{"issue_number":12}' } }],
          },
        }],
      },
      {
        choices: [{
          message: { role: "tool", tool_call_id: "call_1", content: '{"title":"fix bug","state":"open"}' },
        }],
      },
      {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{ id: "call_2", function: { name: "post_comment", arguments: '{"body":"done"}' } }],
          },
        }],
      },
      {
        choices: [{
          message: { role: "tool", tool_call_id: "call_2", content: '{"id":99}' },
        }],
      },
    ];
    const traces = parseOpenAIToolCalls(logs);
    expect(traces.size).toBe(1);
    const events = traces.get("openai-sequence")!;
    expect(events.map((e) => e.name)).toEqual(["get_issue", "post_comment"]);
    expect(events[0]!.result).toEqual({ title: "fix bug", state: "open" });
  });

  test("groups OpenAI logs into per-conversation traces when export metadata exists", () => {
    // Four identical conversations: the compiler's minSupport=3 gate needs
    // ≥3 TRACES repeating a sequence — a single cross-conversation
    // super-trace could never qualify (and fabricated stretches besides).
    const convo = (id: number) => [
      {
        conversation_id: `conv-${id}`,
        choices: [{ message: { role: "assistant", tool_calls: [{ id: `c${id}-1`, function: { name: "gh_pr_view", arguments: '{"pr":"10' + id + '"}' } }] } }],
      },
      { conversation_id: `conv-${id}`, choices: [{ message: { role: "tool", tool_call_id: `c${id}-1`, content: '{"pr":true}' } }] },
      {
        conversation_id: `conv-${id}`,
        choices: [{ message: { role: "assistant", tool_calls: [{ id: `c${id}-2`, function: { name: "gh_pr_checks", arguments: '{"pr":"10' + id + '"}' } }] } }],
      },
      { conversation_id: `conv-${id}`, choices: [{ message: { role: "tool", tool_call_id: `c${id}-2`, content: '{"state":"pass"}' } }] },
    ];
    const logs = [0, 1, 2, 3].flatMap(convo);
    const traces = parseOpenAIToolCalls(logs);
    expect(traces.size).toBe(4);
    for (const events of traces.values()) {
      expect(events.map((e) => e.name)).toEqual(["gh_pr_view", "gh_pr_checks"]);
    }
  });

  test("detectAndParse routes raw OpenAI logs instead of rejecting them", () => {
    const log = JSON.stringify([
      {
        conversation_id: "conv-1",
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "x1", function: { name: "a_tool", arguments: "{}" } }] } }],
      },
      { conversation_id: "conv-1", choices: [{ message: { role: "tool", tool_call_id: "x1", content: '{"ok":1}' } }] },
      {
        conversation_id: "conv-1",
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "x2", function: { name: "b_tool", arguments: "{}" } }] } }],
      },
      { conversation_id: "conv-1", choices: [{ message: { role: "tool", tool_call_id: "x2", content: '{"ok":2}' } }] },
    ]);
    const result = detectAndParse(log);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("openai_logs");
    expect(result!.traces.size).toBe(1);
  });

  test("parses Langfuse TOOL observations", () => {
    const observations = [
      { type: "TOOL", name: "search", input: { q: "test" }, output: { hits: 3 }, level: "DEFAULT", startTime: "2026-01-01T00:00:00Z", traceId: "lf-1" },
      { type: "LLM", name: "gpt4o", input: {}, output: {}, level: "DEFAULT", startTime: "2026-01-01T00:00:01Z", traceId: "lf-1" },
      { type: "TOOL", name: "write", input: { path: "a.ts" }, output: { ok: true }, level: "DEFAULT", startTime: "2026-01-01T00:00:02Z", traceId: "lf-1" },
    ];
    const traces = parseLangfuseObservations(observations);
    expect(traces.size).toBe(1);
    const events = traces.get("lf-1")!;
    expect(events.map((e) => e.name)).toEqual(["search", "write"]);
    expect(events[0]!.ok).toBe(true);
  });
});

/**
 * End-to-end cold-start proof: imported traces flow through the EXISTING
 * compile pipeline without modification. This is what eliminates cold start —
 * users get compiled tools from history on day 1.
 */
describe("imported traces compile through the standard pipeline", () => {
  test("imported kubectl loop produces islands with skeleton names", () => {
    const jsonl = [
      '{"name":"Bash","command":"kubectl get pods -n prod","args":{"command":"kubectl get pods -n prod"},"ok":true}',
      '{"name":"Bash","command":"kubectl get svc -n prod","args":{"command":"kubectl get svc -n prod"},"ok":true}',
      '{"name":"Bash","command":"kubectl get deployments -n prod","args":{"command":"kubectl get deployments -n prod"},"ok":true}',
    ].join("\n");
    const parsed = parseGenericJsonl(jsonl);
    const islands = cutIslands(parsed as unknown as ToolEvent[], { allowRunnerOnly: true });
    expect(islands.length).toBe(1);
    const names = islands[0]!.map((s) => s.name);
    expect(names.every((n) => n.startsWith("kubectl.get"))).toBe(true);
  });

  test("imported curl bundle forms a cloud island with resource-chain name", () => {
    const jsonl = [
      '{"name":"Bash","command":"curl -s https://api.acme.com/v2/invoices/in_001","args":{"command":"curl -s https://api.acme.com/v2/invoices/in_001"},"ok":true}',
      '{"name":"Bash","command":"curl -s https://api.acme.com/v2/invoices/in_001/lines","args":{"command":"curl -s https://api.acme.com/v2/invoices/in_001/lines"},"ok":true}',
    ].join("\n");
    const parsed = parseGenericJsonl(jsonl);
    const islands = cutIslands(parsed as unknown as ToolEvent[]);
    expect(islands.length).toBe(1);
    expect(islands[0]!.every((s) => s.kind === "cloud_http")).toBe(true);
  });
});

describe("import tolerance (P4)", () => {
  test("one malformed LangSmith line no longer rejects the whole export", () => {
    const lines = [
      JSON.stringify({ run_type: "tool", name: "lookupTicket", inputs: { id: "T-1" }, outputs: { ok: true } }),
      "{this is not json",
      JSON.stringify({ run_type: "tool", name: "lookupTicket", inputs: { id: "T-2" }, outputs: { ok: true } }),
      JSON.stringify({ run_type: "tool", name: "lookupTicket", inputs: { id: "T-3" }, outputs: { ok: true } }),
    ];
    const res = detectAndParse(lines.join("\n"));
    expect(res).not.toBeNull();
    expect(res!.format).toBe("langsmith");
    const total = [...res!.traces.values()].reduce((n, evs) => n + evs.length, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
