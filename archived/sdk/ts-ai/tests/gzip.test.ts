/**
 * K35 — wire Content-Encoding on ingest POST (N2: zstd-when-available,
 * gzip fallback). The SDK compresses every ingest POST; on the Bun
 * runtime it prefers native `Bun.zstdCompressSync` (`Content-Encoding:
 * zstd`), falling back to gzip level 1 elsewhere. These tests accept
 * whichever encoding the active runtime produces and round-trip it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { EdenSDK, resetDefaultClient } from "../src/client.js";
import { type TelemetryEvent } from "../src/types.js";

/** Decompress a wire body according to its Content-Encoding header. */
function decodeWire(body: Buffer, encoding: string | null | undefined): string {
  const enc = (encoding ?? "").toLowerCase().trim();
  if (enc === "zstd") {
    // Bun runtime only — tests run under Bun so this is available.
    const dec = (globalThis as { Bun?: { zstdDecompressSync?: (d: Uint8Array) => Uint8Array } })
      .Bun?.zstdDecompressSync;
    if (!dec) throw new Error("zstd body but no Bun.zstdDecompressSync");
    return new TextDecoder().decode(dec(body));
  }
  return gunzipSync(body).toString("utf8");
}

function makeEvent(): TelemetryEvent {
  return {
    eventId: "e1",
    tenantId: "org_test",
    projectId: "default",
    traceId: "t1",
    realm: "production",
    eventType: "agent.run",
    timestamp: new Date().toISOString(),
    sourceFormat: "openai",
    payload: { event_id: "e1", event_type: "agent.run" },
  };
}

describe("wire-compressed ingest", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetDefaultClient();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetDefaultClient();
  });

  it("posts a supported Content-Encoding and round-trips JSON", async () => {
    const seen: { encoding?: string | null; body?: Buffer } = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.encoding = new Headers(init?.headers).get("content-encoding");
      const body = init?.body;
      if (Buffer.isBuffer(body)) {
        seen.body = body;
      } else if (body instanceof Uint8Array) {
        seen.body = Buffer.from(body);
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as typeof fetch;

    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
      maxBatchSize: 1,
      flushIntervalMs: 10_000,
    });
    sdk.emit(makeEvent());
    await sdk.flush();

    // Either zstd (Bun runtime) or gzip (Node) — both are accepted by
    // the gateway (providers.py sniffs zstd magic + Content-Encoding).
    expect(["gzip", "zstd"]).toContain(seen.encoding);
    expect(seen.body).toBeTruthy();
    const decoded = JSON.parse(decodeWire(seen.body!, seen.encoding));
    expect(Array.isArray(decoded)).toBe(true);
    // Full TelemetryEvent wire envelope (eventToWire), not nested
    // payload alone — otherwise event_type is missing on the wire.
    expect(decoded[0].event_id).toBe("e1");
    expect(decoded[0].event_type).toBe("agent.run");
    expect(decoded[0].source_format).toBe("openai");
    expect(decoded[0].tenant_id).toBe("org_test");
    expect(decoded[0].payload).toEqual({
      event_id: "e1",
      event_type: "agent.run",
    });
  });

  it("reuses the compressed body across retries without re-encoding", async () => {
    let attempts = 0;
    const bodies: Buffer[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // Ignore stray POSTs from other clients; this assertion is
      // about body reuse on *this* ingest URL's retry loop.
      if (!url.includes("/orgs/org_test/ingest/openai")) {
        return new Response("{}", { status: 200 });
      }
      attempts += 1;
      const body = init?.body;
      // Keep the same reference — Buffer.from() would allocate a
      // copy and break the reuse assertion.
      if (Buffer.isBuffer(body)) bodies.push(body);
      else if (body instanceof Uint8Array) bodies.push(body as Buffer);
      if (attempts < 2) {
        return new Response("busy", { status: 503 });
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as typeof fetch;

    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
      maxBatchSize: 1,
      flushIntervalMs: 10_000,
      timeoutS: 2,
    });
    sdk.emit(makeEvent());
    await sdk.flush();

    expect(attempts).toBe(2);
    expect(bodies.length).toBe(2);
    // Same Buffer instance reused across retry attempts (no re-compress).
    expect(bodies[0]).toBe(bodies[1]);
  });
});
