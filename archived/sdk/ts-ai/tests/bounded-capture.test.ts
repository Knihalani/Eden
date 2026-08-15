/**
 * Integration tests: bounded capture wired into `trace()`'s
 * `setInput`/`setOutput`, and its interaction with client-side
 * sampling.
 *
 * Mirrors `sdk/python/tests/test_bounded_capture_integration.py`'s
 * trace + sampling-interaction sections. Auto-instrumentation
 * (`wrapOpenAI`, `wrapAnthropic`, ...) intentionally stays
 * metrics-only and is untouched by `captureMode` — see
 * `capture.test.ts` for the pure-unit coverage of the capture module
 * itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseFetchBody } from "./_parseBody.js";
import {
  EdenSDK,
  getDefaultClient,
  resetDefaultClient,
  setDefaultClient,
  type TelemetryEvent,
} from "../src/client.js";
import { wireToEvent } from "../src/wire.js";
import { configure, trace } from "../src/trace.js";
import { OfflineQueue } from "../src/offline-queue.js";
import { TRUNCATED_ATTR, CAPTURE_MODE_ATTR } from "../src/capture.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LONG_TEXT = "eden-test-content-".repeat(2000); // ~38 KiB

interface CapturedRequest {
  url: string;
  body: unknown;
}

let captured: CapturedRequest[];
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body;
    try {
      body = parseFetchBody(init);
    } catch {
      // keep raw
    }
    captured.push({ url, body });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
  }) as unknown) as typeof fetch;
  resetDefaultClient();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDefaultClient();
});

function flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      events.push(
        ...(req.body as Record<string, unknown>[]).map(
          (w) => wireToEvent(w) as unknown as TelemetryEvent,
        ),
      );
    }
  }
  return events;
}

// ── trace() setInput/setOutput ──────────────────────────────────────

describe("trace() setInput/setOutput bounded capture", () => {
  it("truncates long input/output and stamps metadata", async () => {
    configure({ orgId: "o", apiKey: "k", captureMode: "bounded" });
    const t = trace("long-io");
    t.setInput({ prompt: LONG_TEXT });
    t.setOutput({ completion: LONG_TEXT });
    t.end();
    await getDefaultClient().flush();

    const ev = flattenEvents().find((e) => e.payload?.name === "long-io");
    expect(ev).toBeDefined();
    const payload = ev!.payload as { input: { prompt: string }; output: { completion: string } };
    expect(payload.input.prompt.length).toBeLessThan(LONG_TEXT.length);
    expect(payload.output.completion.length).toBeLessThan(LONG_TEXT.length);
    expect((ev!.attributes as Record<string, unknown>)[TRUNCATED_ATTR]).toBe("true");
  });

  it("keeps full input on an error span", async () => {
    configure({ orgId: "o", apiKey: "k", captureMode: "bounded" });
    const t = trace("long-io-error");
    t.setInput({ prompt: LONG_TEXT });
    t.setStatus("error", { error: "boom" });
    t.end();
    await getDefaultClient().flush();

    const ev = flattenEvents().find((e) => e.payload?.name === "long-io-error");
    expect(ev).toBeDefined();
    const payload = ev!.payload as { input: { prompt: string } };
    expect(payload.input.prompt).toBe(LONG_TEXT);
    expect((ev!.attributes as Record<string, unknown>)[TRUNCATED_ATTR]).toBe("false");
  });

  it("captureMode='full' bypasses truncation", async () => {
    configure({ orgId: "o", apiKey: "k", captureMode: "full" });
    const t = trace("long-io-full");
    t.setInput(LONG_TEXT);
    t.setOutput(LONG_TEXT);
    t.end();
    await getDefaultClient().flush();

    const ev = flattenEvents().find((e) => e.payload?.name === "long-io-full");
    expect(ev).toBeDefined();
    const payload = ev!.payload as { input: string; output: string };
    expect(payload.input).toBe(LONG_TEXT);
    expect(payload.output).toBe(LONG_TEXT);
    expect((ev!.attributes as Record<string, unknown>)[CAPTURE_MODE_ATTR]).toBe("full");
  });

  it("captureMode='metrics_only' drops content", async () => {
    configure({ orgId: "o", apiKey: "k", captureMode: "metrics_only" });
    const t = trace("long-io-metrics-only");
    t.setInput({ prompt: "hi" });
    t.setOutput({ completion: "hi" });
    t.end();
    await getDefaultClient().flush();

    const ev = flattenEvents().find((e) => e.payload?.name === "long-io-metrics-only");
    expect(ev).toBeDefined();
    const payload = ev!.payload as { input: unknown; output: unknown };
    expect(payload.input).toBeNull();
    expect(payload.output).toBeNull();
    expect((ev!.attributes as Record<string, unknown>)[CAPTURE_MODE_ATTR]).toBe("metrics_only");
  });

  it("a span that never calls setInput/setOutput omits those fields, unaffected by captureMode", async () => {
    configure({ orgId: "o", apiKey: "k", captureMode: "bounded" });
    const t = trace("no-io");
    t.end();
    await getDefaultClient().flush();

    const ev = flattenEvents().find((e) => e.payload?.name === "no-io");
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload.input).toBeUndefined();
    expect(payload.output).toBeUndefined();
  });
});

// ── Sampling + bounded-capture interaction ──────────────────────────
//
// Truncation happens inside `finishTrace` before `client.emit()` is
// ever called; sampling happens *inside* `emit()`. These tests pin
// that the two compose correctly rather than one silently defeating
// the other.

describe("sampling + bounded-capture interaction", () => {
  it(
    "an error span is force-kept under an aggressive sampling profile, and capture keeps its full content",
    async () => {
      // `EdenSDK.configure()` (called by the free `configure()` helper)
      // only rebuilds `this.config`, not `this.sampler` -- so a
      // non-default samplingProfile must be passed at construction
      // time via `setDefaultClient(new EdenSDK({...}))` instead.
      const client = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        captureMode: "bounded",
        samplingProfile: "aggressive",
        sampleKeepErrors: true,
      });
      setDefaultClient(client);
      const t = trace("err-under-aggressive-sampling");
      t.setInput({ prompt: LONG_TEXT });
      t.setStatus("error", { error: "boom" });
      t.end();
      await client.flush();

      // Aggressive profile keep-rate is 5% -- force-keep-on-error
      // must not be probabilistic.
      expect(client.sampledOut).toBe(0);
      const ev = flattenEvents().find(
        (e) => e.payload?.name === "err-under-aggressive-sampling",
      );
      expect(ev).toBeDefined();
      const payload = ev!.payload as { input: { prompt: string } };
      expect(payload.input.prompt).toBe(LONG_TEXT);
      expect((ev!.attributes as Record<string, unknown>)[TRUNCATED_ATTR]).toBe("false");
    },
  );

  it(
    "a truncated success span is still delivered under the (deterministic) full sampling profile",
    async () => {
      const client = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        captureMode: "bounded",
        samplingProfile: "full",
      });
      setDefaultClient(client);
      const t = trace("ok-under-full-sampling");
      t.setOutput({ completion: LONG_TEXT });
      t.end();
      await client.flush();

      expect(client.sampledOut).toBe(0);
      const ev = flattenEvents().find((e) => e.payload?.name === "ok-under-full-sampling");
      expect(ev).toBeDefined();
      const payload = ev!.payload as { output: { completion: string } };
      expect(payload.output.completion.length).toBeLessThan(LONG_TEXT.length);
      expect((ev!.attributes as Record<string, unknown>)[TRUNCATED_ATTR]).toBe("true");
    },
  );

  it(
    "offline replay bypasses ClientSampler regardless of whether the stored payload was already truncated",
    async () => {
      // Mirrors the Python force-keep test: `flushOffline()` never
      // routes through `ClientSampler` at all (see `EdenSDK.flushOffline`),
      // so a durable row survives an aggressive profile independent of
      // whatever bounded capture already did to its payload upstream.
      const tmpDir = mkdtempSync(join(tmpdir(), "eden-capture-sampling-"));
      const qpath = join(tmpDir, "replay.jsonl");
      const q = new OfflineQueue(qpath);
      // Simulate a payload that bounded capture already truncated
      // before it was spilled to the offline queue.
      q.enqueue("openai", {
        event_id: "replay-truncated",
        request_payload: { messages: [{ content: "…[eden:truncated 9000b]…" }] },
        attributes: { [TRUNCATED_ATTR]: "true" },
      });

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        baseUrl: "http://localhost:8000",
        offlineQueuePath: qpath,
        samplingProfile: "aggressive",
        sampleKeepErrors: true,
      });
      const n = await sdk.flushOffline(10);
      expect(n).toBe(1);
      expect(sdk.sampledOut).toBe(0);
      const freshQ = new OfflineQueue(qpath);
      expect(freshQ.size()).toBe(0);
    },
  );
});
