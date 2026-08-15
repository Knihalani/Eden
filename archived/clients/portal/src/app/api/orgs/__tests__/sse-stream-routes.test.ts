// @vitest-environment node
/**
 * Wave 9.4 — dedicated org SSE stream proxies preserve FastAPI
 * handshake envelopes and forward client abort to upstream fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/lib/server/clerk-bearer", () => ({
  bearerHeader: async () => ({}),
}));

beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dedicated observability stream handshake", () => {
  it("preserves FastAPI internal_error body on handshake 500", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "internal_error",
          detail: "An unexpected error occurred",
          request_id: "obs-fastapi-rid",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { GET } = await import(
      "@/app/api/orgs/[orgId]/observability/stream/route"
    );
    const res = await GET(
      new Request("http://localhost/api/orgs/org_1/observability/stream"),
      { params: Promise.resolve({ orgId: "org_1" }) },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "internal_error",
      detail: "An unexpected error occurred",
      request_id: "obs-fastapi-rid",
    });
    expect(res.headers.get("X-Request-ID")).toBe("obs-fastapi-rid");
  });

  it("passes AbortSignal to upstream fetch", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("event: ping\ndata: {}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const ac = new AbortController();
    const req = new Request(
      "http://localhost/api/orgs/org_1/observability/stream",
      { signal: ac.signal },
    );
    const { GET } = await import(
      "@/app/api/orgs/[orgId]/observability/stream/route"
    );
    await GET(req, { params: Promise.resolve({ orgId: "org_1" }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    // Forward the Request's signal (may be a wrapper around ac.signal).
    expect(init.signal).toBe(req.signal);
    expect(init.signal).toBeTruthy();
  });
});

describe("dedicated live trace events handshake", () => {
  it("preserves FastAPI internal_error body on handshake 500", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "internal_error",
          detail: "An unexpected error occurred",
          request_id: "live-fastapi-rid",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { GET } = await import(
      "@/app/api/orgs/[orgId]/stream/traces/[sessionId]/events/route"
    );
    const res = await GET(
      new Request(
        "http://localhost/api/orgs/org_1/stream/traces/sess_1/events",
      ),
      {
        params: Promise.resolve({ orgId: "org_1", sessionId: "sess_1" }),
      },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "internal_error",
      detail: "An unexpected error occurred",
      request_id: "live-fastapi-rid",
    });
  });
});
