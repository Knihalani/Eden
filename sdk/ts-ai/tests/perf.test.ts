/**
 * Performance / overhead benchmarks for the @eden-ai/sdk.
 *
 * The contract: SDK overhead (emit + auto-flush) must add no more
 * than 1 ms p99 vs the uninstrumented baseline. This matches the
 * Python SDK's 5 ms p99 target, with a tighter bound because the
 * TS hot path is a plain array.push.
 */

import { describe, expect, it } from "bun:test";
import { EdenSDK } from "../src/client.js";

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

describe("EdenSDK performance", () => {
  it("emit() p99 overhead is under 1 ms", () => {
    const sdk = new EdenSDK({ orgId: "perf", apiKey: "k" });
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
    const sdk = new EdenSDK({ orgId: "perf", apiKey: "k" });
    // Warm-up
    for (let i = 0; i < 1000; i++) sdk.emit(sampleEvent(i));
    // Measure throughput
    const N = 50_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) sdk.emit(sampleEvent(i));
    const elapsed = performance.now() - t0;
    const rate = N / (elapsed / 1000);
    console.log(
      `[perf] emit throughput=${Math.round(rate).toLocaleString()}/s over ${elapsed.toFixed(1)}ms`,
    );
    expect(rate).toBeGreaterThan(100_000);
  });
});
