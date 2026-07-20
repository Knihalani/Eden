// @vitest-environment node
/**
 * W3-C / F35 — ``proxyError`` + ``streamHandshakeFailure`` status mapping.
 * Wave 1 ``proxy-error-taxonomy``: every envelope carries ``request_id``.
 */
import { describe, expect, it } from "vitest";
import {
  proxyError,
  pipeSseUpstream,
  streamHandshakeFailure,
  streamHandshakeFromUpstream,
} from "@/lib/proxy";

describe("proxyError (F35 + transient mapping)", () => {
  it.each([
    "Not authenticated",
    "Invalid or expired token",
    "Token has expired",
    "Session expired",
    "Unauthorized",
  ])("maps auth detail %j → 401", async (msg) => {
    const res = proxyError(new Error(msg), "fallback");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.detail).toBe(msg);
    expect(body.request_id).toBeTruthy();
    expect(res.headers.get("X-Request-ID")).toBe(body.request_id);
  });

  it("maps AbortError / timeout → 502 Backend timed out", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const res = proxyError(abort, "fallback");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Backend timed out");
    expect(body.cause).toBe("The operation was aborted");
    expect(body.request_id).toBeTruthy();
  });

  it("maps ECONNREFUSED → 502 Backend unreachable", async () => {
    const res = proxyError(new Error("fetch failed: ECONNREFUSED"), "fallback");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Backend unreachable");
    expect(body.request_id).toBeTruthy();
  });

  it("maps circuit-open wording → 503", async () => {
    const res = proxyError(new Error("Backend circuit open"), "fallback");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.request_id).toBeTruthy();
  });

  it("maps unrelated errors → 500 with request_id (not opaque)", async () => {
    const res = proxyError(new Error("boom in serializer"), "fallback", "rid-residual");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      detail: "boom in serializer",
      request_id: "rid-residual",
    });
    expect(res.headers.get("X-Request-ID")).toBe("rid-residual");
  });
});

describe("streamHandshakeFailure", () => {
  it("promotes transport failure without upstream status to 502", async () => {
    const res = streamHandshakeFailure({
      error: new Error("ECONNREFUSED"),
      fallbackDetail: "Failed to connect to observability stream",
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Backend unreachable");
    expect(body.request_id).toBeTruthy();
  });

  it("passes through known upstream 503 with clear detail", async () => {
    const req = new Request("http://localhost/stream", {
      headers: { "x-request-id": "rid-stream-1" },
    });
    const res = streamHandshakeFailure({
      request: req,
      upstreamStatus: 503,
      upstreamDetail: "no healthy upstream",
      fallbackDetail: "Failed to connect",
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("45");
    const body = await res.json();
    expect(body.detail).toBe("no healthy upstream");
    expect(body.upstream_status).toBe(503);
    expect(body.request_id).toBe("rid-stream-1");
  });

  it("passes through upstream 401 auth detail", async () => {
    const res = streamHandshakeFailure({
      upstreamStatus: 401,
      upstreamDetail: "Invalid or expired token",
      fallbackDetail: "Failed to connect",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.detail).toBe("Invalid or expired token");
  });
});

describe("streamHandshakeFromUpstream (Wave 9.4)", () => {
  it("preserves FastAPI internal_error + request_id without double-wrap", async () => {
    const upstream = new Response(
      JSON.stringify({
        error: "internal_error",
        detail: "An unexpected error occurred",
        request_id: "fastapi-sse-rid",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
    const res = await streamHandshakeFromUpstream({
      upstream,
      fallbackDetail: "Failed to connect to observability stream",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: "internal_error",
      detail: "An unexpected error occurred",
      request_id: "fastapi-sse-rid",
    });
    expect(res.headers.get("X-Request-ID")).toBe("fastapi-sse-rid");
    expect(body.detail).not.toBe("Failed to connect to observability stream");
  });

  it("stamps portal request_id when upstream envelope omits it", async () => {
    const req = new Request("http://localhost/stream", {
      headers: { "x-request-id": "portal-rid-9" },
    });
    const upstream = new Response(JSON.stringify({ detail: "boom" }), {
      status: 502,
    });
    const res = await streamHandshakeFromUpstream({
      request: req,
      upstream,
      fallbackDetail: "Failed to connect",
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("boom");
    expect(body.request_id).toBe("portal-rid-9");
  });
});

describe("pipeSseUpstream abort handling (Wave 9.4)", () => {
  it("cancel() cancels the upstream reader", async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const res = pipeSseUpstream(upstream, { heartbeatMs: 60_000 });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    await res.body!.cancel();
    expect(cancelled).toBe(true);
  });

  it("AbortSignal cancels the upstream reader", async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const upstream = new Response(upstreamBody, { status: 200 });
    const ac = new AbortController();
    const res = pipeSseUpstream(upstream, {
      heartbeatMs: 60_000,
      signal: ac.signal,
    });
    // Start consuming so start() attaches the abort listener.
    const reader = res.body!.getReader();
    await Promise.resolve();
    ac.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
    reader.releaseLock();
  });
});
