// @vitest-environment node
/**
 * F37 — ``forwardToBackend`` must forward throttling headers.
 *
 * The browser-side ``fetchApi`` (lib/api.ts) reads ``Retry-After`` off
 * the response it receives from the ``/api/proxy`` route — not the
 * upstream FastAPI response directly. Before this fix,
 * ``NextResponse.json(parsed, { status })`` only carried the status
 * code through the JSON round-trip; every ``Retry-After`` /
 * ``X-RateLimit-*`` header FastAPI sent on a 429 was silently
 * dropped, so the client always fell back to the generic 5s default
 * instead of honoring the upstream's real cooldown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { __resetProxyCircuitBreakerForTests, forwardToBackend } from "@/lib/proxy";

beforeEach(() => {
  fetchMock.mockReset();
  __resetProxyCircuitBreakerForTests();
});

afterEach(() => {
  __resetProxyCircuitBreakerForTests();
});

describe("forwardToBackend rate-limit header passthrough (F37)", () => {
  it("forwards Retry-After from a 429 upstream response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Too many requests" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "12" },
      }),
    );
    const res = await forwardToBackend("/orgs/x/agents", { method: "GET" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
  });

  it("forwards X-RateLimit-* headers when present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1700000000",
        },
      }),
    );
    const res = await forwardToBackend("/orgs/x/agents", { method: "GET" });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("1700000000");
  });

  it("does not set Retry-After when the upstream omits it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await forwardToBackend("/orgs/x/agents", { method: "GET" });
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
