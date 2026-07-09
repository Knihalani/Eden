/**
 * Wire-format translation between the TS SDK's camelCase types
 * and the server's snake_case ingestion schema.
 *
 * Translation is intentionally a FLAT rename (no recursion into
 * nested fields): the SDK's instrumentations emit snake_case keys
 * for ``payload``/``metrics``/``attributes`` directly, so only
 * the top-level field names are camelCase internally.
 */

import { describe, it, expect } from "bun:test";
import { eventToWire, chunkToWire, wireToEvent, wireToChunk } from "../src/wire";

describe("wire format (camelCase ↔ snake_case, top-level rename)", () => {
  it("translates telemetry event top-level fields", () => {
    const wire = eventToWire({
      eventId: "ev1",
      tenantId: "t1",
      projectId: "p1",
      traceId: "tr1",
      realm: "production",
      eventType: "llm_completion",
      timestamp: "2025-01-01T00:00:00Z",
      sourceFormat: "openai",
      payload: { provider: "openai" },
      agentId: "agent-1",
      agentVersion: "v1",
      environmentId: "env-1",
      parentSpanId: "p-1",
      spanId: "s-1",
      durationMs: 120,
      modelNormalized: "gpt-4o",
    });
    expect(wire.event_id).toBe("ev1");
    expect(wire.tenant_id).toBe("t1");
    expect(wire.project_id).toBe("p1");
    expect(wire.trace_id).toBe("tr1");
    expect(wire.event_type).toBe("llm_completion");
    expect(wire.source_format).toBe("openai");
    expect(wire.agent_id).toBe("agent-1");
    expect(wire.agent_version).toBe("v1");
    expect(wire.environment_id).toBe("env-1");
    expect(wire.parent_span_id).toBe("p-1");
    expect(wire.span_id).toBe("s-1");
    expect(wire.duration_ms).toBe(120);
    expect(wire.model_normalized).toBe("gpt-4o");
    // Non-mapped fields pass through.
    expect(wire.realm).toBe("production");
    expect(wire.timestamp).toBe("2025-01-01T00:00:00Z");
  });

  it("preserves nested payload by value (already snake_case)", () => {
    const wire = eventToWire({
      eventId: "ev1",
      tenantId: "t1",
      projectId: "p1",
      traceId: "tr1",
      realm: "production",
      eventType: "llm_completion",
      timestamp: "2025-01-01T00:00:00Z",
      sourceFormat: "openai",
      payload: { provider: "openai", prompt_tokens: 5 },
    });
    // Nested values are NOT recursed — they pass through unchanged.
    expect((wire.payload as Record<string, unknown>).provider).toBe("openai");
    expect((wire.payload as Record<string, unknown>).prompt_tokens).toBe(5);
  });

  it("translates stream chunk fields", () => {
    const wire = chunkToWire({
      eventId: "ev1",
      traceId: "tr1",
      chunkIndex: 0,
      deltaText: "Hi",
      reasoningDelta: null,
      toolCallDelta: null,
      ttftMs: 100,
      itlMs: 12,
      tpotMs: 6,
      receivedAtClientMs: 1700000000000,
    });
    expect(wire.event_id).toBe("ev1");
    expect(wire.trace_id).toBe("tr1");
    expect(wire.chunk_index).toBe(0);
    expect(wire.delta_text).toBe("Hi");
    expect(wire.ttft_ms).toBe(100);
    expect(wire.itl_ms).toBe(12);
    expect(wire.tpot_ms).toBe(6);
    expect(wire.received_at_client_ms).toBe(1700000000000);
  });

  it("inverse: wireToEvent converts snake_case back", () => {
    const out = wireToEvent({
      event_id: "ev1",
      tenant_id: "t1",
      project_id: "p1",
      trace_id: "tr1",
      event_type: "agent_call",
      source_format: "openai",
      agent_id: "a",
      duration_ms: 5,
    });
    expect(out.eventId).toBe("ev1");
    expect(out.tenantId).toBe("t1");
    expect(out.eventType).toBe("agent_call");
    expect(out.sourceFormat).toBe("openai");
    expect(out.durationMs).toBe(5);
  });

  it("inverse: wireToChunk converts snake_case back", () => {
    const out = wireToChunk({
      event_id: "ev1",
      trace_id: "tr1",
      chunk_index: 0,
      delta_text: "Hi",
      tpot_ms: 6,
    });
    expect(out.eventId).toBe("ev1");
    expect(out.deltaText).toBe("Hi");
    expect(out.tpotMs).toBe(6);
  });

  it("non-mapped fields pass through unchanged in both directions", () => {
    const wire = eventToWire({
      eventId: "x",
      tenantId: "t",
      projectId: "p",
      traceId: "tr",
      realm: "production",
      eventType: "y",
      timestamp: "now",
      sourceFormat: "openai",
      payload: {},
    });
    expect(wire.realm).toBe("production");
    expect(wire.timestamp).toBe("now");
  });
});
