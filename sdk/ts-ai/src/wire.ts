/**
 * Wire-format conversion between the TS SDK's camelCase types and
 * the server's snake_case ingestion schema.
 *
 * Why this exists: the TS SDK keeps camelCase internally for
 * ergonomics (``eventType``, ``traceId``, ``sourceFormat``), but
 * the gateway's ``normalizer`` reads strict snake_case
 * (``event_type``, ``trace_id``, ``source_format``). Sending
 * camelCase over the wire would cause every TS event to land as
 * ``event_type: "ingest.event"`` and silently miss every SQL
 * filter (``WHERE event_type = 'agent.run'``). Translation runs
 * only at the wire boundary so internal callers stay
 * camelCase.
 *
 * Design note: the SDK's instrumentations directly write
 * snake_case keys for nested fields (``payload``,
 * ``payload.metrics`` like ``ttft_ms``/``itl_ms_avg``, and
 * ``payload.chunk_count``) — those don't need any conversion.
 * Only the *top-level* ``TelemetryEvent`` shape is camelCase, so
 * the conversion is a flat rename per-record, not a deep walker.
 * A deep walker would corrupt the already-snake_case nested
 * fields by accidentally converting them to camelCase on the
 * return path.
 *
 * Mirrors the Python SDK's Pydantic models (``TelemetryEvent`` is
 * already snake_case in Python — no translation needed there).
 */

import type { TelemetryEvent, StreamChunk } from "./types";

/**
 * Field-name overrides for a {@link TelemetryEvent}. Each key is
 * the TS SDK's camelCase field; the value is the server's
 * snake_case equivalent. Used as a flat rename — nested values
 * are not recursed into.
 */
const EVENT_FIELD_MAP: Record<string, string> = {
  eventId: "event_id",
  tenantId: "tenant_id",
  projectId: "project_id",
  traceId: "trace_id",
  eventType: "event_type",
  sourceFormat: "source_format",
  agentId: "agent_id",
  agentVersion: "agent_version",
  environmentId: "environment_id",
  parentSpanId: "parent_span_id",
  spanId: "span_id",
  durationMs: "duration_ms",
  modelNormalized: "model_normalized",
};

/**
 * Translate a {@link TelemetryEvent} from the TS SDK's camelCase
 * shape to the server's snake_case shape. Flat rename only —
 * nested ``payload`` / ``metrics`` / ``attributes`` are already
 * snake_case inside the SDK (instrumentations emit them that way)
 * and pass through unchanged.
 */
export function eventToWire(event: TelemetryEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event as unknown as Record<string, unknown>)) {
    const key = EVENT_FIELD_MAP[k] ?? k;
    out[key] = v;
  }
  return out;
}

/**
 * Field-name overrides for a {@link StreamChunk}.
 */
const CHUNK_FIELD_MAP: Record<string, string> = {
  eventId: "event_id",
  traceId: "trace_id",
  chunkIndex: "chunk_index",
  deltaText: "delta_text",
  reasoningDelta: "reasoning_delta",
  toolCallDelta: "tool_call_delta",
  ttftMs: "ttft_ms",
  itlMs: "itl_ms",
  tpotMs: "tpot_ms",
  receivedAtClientMs: "received_at_client_ms",
};

/**
 * Translate a {@link StreamChunk} from camelCase to snake_case.
 * The gateway's ``ChunksIngestRequest`` is snake_case; missing
 * the conversion here would leave ``deltaText``/``tpotMs``
 * unreadable server-side.
 */
export function chunkToWire(chunk: StreamChunk): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(chunk as unknown as Record<string, unknown>)) {
    const key = CHUNK_FIELD_MAP[k] ?? k;
    out[key] = v;
  }
  return out;
}

/**
 * Inverse mappings — used by the test suite to inspect captured
 * wire bodies in terms of the SDK's internal camelCase types.
 * Same flat-rename semantics as the forward converters.
 */
const EVENT_INVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_FIELD_MAP).map(([k, v]) => [v, k]),
);
const CHUNK_INVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHUNK_FIELD_MAP).map(([k, v]) => [v, k]),
);

/**
 * Convert a wire-shaped event (snake_case top-level keys) back
 * to a {@link TelemetryEvent}-shaped record (camelCase). Used by
 * the test suite to inspect captured wire bodies.
 */
export function wireToEvent(wire: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wire)) {
    const key = EVENT_INVERSE_MAP[k] ?? k;
    out[key] = v;
  }
  return out;
}

/**
 * Inverse of {@link chunkToWire}. Used by the test suite.
 */
export function wireToChunk(wire: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wire)) {
    const key = CHUNK_INVERSE_MAP[k] ?? k;
    out[key] = v;
  }
  return out;
}
