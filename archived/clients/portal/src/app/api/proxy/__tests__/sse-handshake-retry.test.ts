// @vitest-environment node
/**
 * Regression test for the F36 SSE handshake Retry-After fix in
 * the catch-all proxy.
 *
 * Pre-fix: the catch-all proxy's SSE branch would dial the
 * upstream and either pipe the bytes through or surface a bare
 * ``Upstream stream error`` text on non-2xx. A 429 from the
 * upstream throttler was treated like any other failure — the
 * consumer-side ``EventSource`` would auto-reconnect
 * immediately, re-tripping the limiter every retry.
 *
 * Post-fix: the SSE branch now reads the upstream's
 * ``Retry-After`` header (or a 5 s default when absent), sleeps
 * the cooldown, and re-dials the upstream exactly once. We
 * deliberately don\'t retry after the body has started emitting
 * bytes because tearing down a live SSE would corrupt the
 * downstream consumer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

// Mock forwardToBackend + proxyError; we don\'t want the SSE
// branch to fall through to the JSON path during the test.
vi.mock("@/lib/proxy", async () => {
  const actual = await vi.importActual<typeof import("@/lib/proxy")>(
    "@/lib/proxy",
  );
  return {
    ...actual,
    forwardToBackend: vi.fn(async () => {
      throw new Error("SSE branch should consume the request in this test");
    }),
  };
});
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ getToken: async () => null }),
}));

import { NextRequest } from "next/server";

// IMPORTANT: stub FETCH BEFORE importing the route so the
// proxy\'s SSE branch picks up the spy.
globalThis.fetch = fetchMock as unknown as typeof fetch;

// Default: the request body is shape-correct for the proxy
// (any GET with Accept: text/event-stream is eligible for the
// SSE branch).
function sseRequest(path: string[]): NextRequest {
  return new NextRequest(
    `http://localhost/api/proxy/${path.join("/")}`,
    {
      method: "GET",
      headers: { accept: "text/event-stream" },
    },
  );
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  vi.useRealTimers();
});

// Lazy-import so the env-mock above is in place.
async function importProxy() {
  return import("../[...path]/route");
}

describe("F36: SSE handshake honours Retry-After on a 429", () => {
  it("retries once after Retry-After=0 and pipes the second 200 body", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { detail: "throttled" }, { "Retry-After": "0" }),
      )
      // Stream response: any 2xx with a body. The proxy just
      // pipes bytes; it doesn\'t parse the stream.
      .mockResolvedValueOnce(
        new Response("event: hi\ndata: ping\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    const route = await importProxy();
    const req = sseRequest(["v1", "observability", "stream"]);
    const resPromise = route.GET(req, { params: Promise.resolve({ path: ["v1", "observability", "stream"] }) });
    await vi.advanceTimersByTimeAsync(50);
    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the 5s default cooldown when Retry-After is absent", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonError(429, { detail: "throttled" } as Record<string, unknown>))
      .mockResolvedValueOnce(
        new Response("event: hi\ndata: ping\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    const route = await importProxy();
    const resPromise = route.GET(
      sseRequest(["v1", "observability", "stream"]),
      { params: Promise.resolve({ path: ["v1", "observability", "stream"] }) },
    );

    // After 4.5 s the retry must still be pending.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After ~5 s total, the retry fires.
    await vi.advanceTimersByTimeAsync(800);
    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry beyond a single handshake attempt", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonError(429, { detail: "throttled" }, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonError(429, { detail: "throttled" }));

    const route = await importProxy();
    const resPromise = route.GET(
      sseRequest(["v1", "observability", "stream"]),
      { params: Promise.resolve({ path: ["v1", "observability", "stream"] }) },
    );
    await vi.advanceTimersByTimeAsync(50);
    const res = await resPromise;
    // The proxy now returns a structured JSON envelope with the
    // upstream status (429, in this case) so the consumer-side
    // SSE hook can decide whether to reconnect.
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.detail).toBe("throttled");
    expect(body.request_id).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves FastAPI internal_error body on SSE handshake 500", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonError(500, {
        error: "internal_error",
        detail: "An unexpected error occurred",
        request_id: "sse-fastapi-rid",
      }),
    );

    const route = await importProxy();
    const res = await route.GET(
      sseRequest(["v1", "observability", "stream"]),
      { params: Promise.resolve({ path: ["v1", "observability", "stream"] }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: "internal_error",
      detail: "An unexpected error occurred",
      request_id: "sse-fastapi-rid",
    });
    expect(res.headers.get("X-Request-ID")).toBe("sse-fastapi-rid");
    // Must not double-wrap into opaque "Upstream stream error".
    expect(body.detail).not.toBe("Upstream stream error");
  });
});

// jsonError helper used above.
function jsonError(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
