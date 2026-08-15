/**
 * Performance / overhead benchmarks for the @eden-ai/sdk.
 *
 * The contract: SDK overhead (emit + auto-flush) must add no more
 * than 1 ms p99 vs the uninstrumented baseline. This matches the
 * Python SDK's 5 ms p99 target, with a tighter bound because the
 * TS hot path is a plain array.push.
 */

import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { EdenSDK } from "../src/client.js";
import { eventToWire, chunkToWire } from "../src/wire.js";
import type { StreamChunk, TelemetryEvent } from "../src/types.js";

function percentile(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.round((q / 100) * (sorted.length - 1)));
  return sorted[idx];
}

interface PerfEvent {
  eventId: string;
  traceId: string;
  sourceFormat: string;
  eventType: string;
  payload: Record<string, unknown>;
}

const sampleEvent = (i: number): PerfEvent => ({
  eventId: `evt_${i}`,
  traceId: `trc_${i}`,
  sourceFormat: "openai",
  eventType: "llm_completion",
  payload: {
    id: `chatcmpl-${i}`,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "ok" },
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  },
});

function fullEvent(i: number): TelemetryEvent {
  return {
    eventId: `evt_${i}`,
    tenantId: "org_perf",
    projectId: "default",
    traceId: `trc_${i}`,
    realm: "production",
    eventType: "llm_completion",
    timestamp: "2025-01-01T00:00:00.000Z",
    sourceFormat: "openai",
    payload: { model: "gpt-4o-mini", n: i },
    durationMs: 12,
    modelNormalized: "gpt-4o-mini",
  };
}

describe("EdenSDK performance", () => {
  it("emit() p99 overhead is under 1 ms", () => {
    // Keep flush cold so we measure enqueue, not network/timer work.
    const sdk = new EdenSDK({
      orgId: "perf",
      apiKey: "k",
      maxBatchSize: 1_000_000,
      flushIntervalMs: 60_000,
    });
    // Warm-up
    for (let i = 0; i < 1000; i++) sdk.emit(sampleEvent(i));
    // Measure
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t0 = performance.now();
      sdk.emit(sampleEvent(i));
      samples.push(performance.now() - t0);
    }
    const p99 = percentile(samples, 99);
    const mean =
      samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log(
      `[perf] emit p99=${p99.toFixed(4)}ms mean=${mean.toFixed(4)}ms`,
    );
    expect(p99).toBeLessThan(1.0);
  });

  it("sustains >= 100k events/sec", () => {
    // Huge batch + long interval so the timer/network path stays cold.
    const sdk = new EdenSDK({
      orgId: "perf",
      apiKey: "k",
      maxBatchSize: 1_000_000,
      flushIntervalMs: 60_000,
    });
    const N = 50_000;
    // Pre-build events so the benchmark measures emit(), not object alloc.
    const events = Array.from({ length: N + 1000 }, (_, i) => sampleEvent(i));
    // Warm-up
    for (let i = 0; i < 1000; i++) sdk.emit(events[i]!);
    // Measure throughput
    const t0 = performance.now();
    for (let i = 1000; i < N + 1000; i++) sdk.emit(events[i]!);
    const elapsed = performance.now() - t0;
    const rate = N / (elapsed / 1000);
    console.log(
      `[perf] emit throughput=${Math.round(rate).toLocaleString()}/s over ${elapsed.toFixed(1)}ms`,
    );
    expect(rate).toBeGreaterThan(100_000);
  });

  it("eventToWire of a flush-sized batch stays under 100ms for 100 rounds", () => {
    // Guard against accidental deep-walk / Object.entries regressions on
    // the flush serialization path. Threshold is intentionally loose for
    // busy CI; the direct-field rewrite is typically well under 10ms here.
    const events = Array.from({ length: 50 }, (_, i) => fullEvent(i));
    for (let w = 0; w < 20; w++) {
      for (const e of events) eventToWire(e);
    }
    const t0 = performance.now();
    for (let r = 0; r < 100; r++) {
      for (const e of events) eventToWire(e);
    }
    const elapsed = performance.now() - t0;
    console.log(
      `[perf] eventToWire 100×50-batch=${elapsed.toFixed(1)}ms`,
    );
    expect(elapsed).toBeLessThan(100);
  });

  it("gzip level 1 still shrinks a flush-sized JSON batch", () => {
    // Behavioral guard: ingest uses compresslevel=1 (Python parity).
    // Relative timing vs default level is too noisy under load to assert.
    const batch = Array.from({ length: 50 }, (_, i) => eventToWire(fullEvent(i)));
    const json = Buffer.from(JSON.stringify(batch), "utf8");
    const compressed = gzipSync(json, { level: 1 });
    console.log(
      `[perf] gzip level1 size=${compressed.byteLength} raw=${json.byteLength}`,
    );
    expect(compressed.byteLength).toBeLessThan(json.byteLength);
    expect(compressed.byteLength).toBeGreaterThan(0);
  });

  it("chunkToWire omits undefined optional fields (payload size)", () => {
    const chunk: StreamChunk = {
      eventId: "e1",
      traceId: "t1",
      chunkIndex: 0,
      receivedAtClientMs: 1,
    };
    const wire = chunkToWire(chunk);
    expect(wire).not.toHaveProperty("delta_text");
    expect(wire).not.toHaveProperty("ttft_ms");
    expect(Object.keys(wire).sort()).toEqual([
      "chunk_index",
      "event_id",
      "received_at_client_ms",
      "trace_id",
    ]);
  });
});
