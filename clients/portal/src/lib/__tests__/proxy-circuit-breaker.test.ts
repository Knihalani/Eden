// @vitest-environment node
/**
 * LP-21 — proxy circuit breaker.
 *
 * After N consecutive upstream fetch failures, ``forwardToBackend``
 * short-circuits with 503 + Retry-After instead of hammering a dead
 * Northflank pod.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_RETRY_AFTER_S,
  __resetProxyCircuitBreakerForTests,
  forwardToBackend,
} from "@/lib/proxy";

beforeEach(() => {
  fetchMock.mockReset();
  __resetProxyCircuitBreakerForTests();
});

afterEach(() => {
  __resetProxyCircuitBreakerForTests();
});

describe("forwardToBackend circuit breaker (LP-21)", () => {
  it("returns 502 on a single fetch failure without opening the circuit", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await forwardToBackend("/health", { method: "GET" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Backend unreachable");
    expect(body.request_id).toBeTruthy();
  });

  it("opens the circuit after consecutive fetch failures", async () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await forwardToBackend("/health", { method: "GET" });
      expect(res.status).toBe(502);
    }

    // Next call short-circuits — no additional fetch.
    fetchMock.mockClear();
    const open = await forwardToBackend("/orgs/x/signals", { method: "GET" });
    expect(open.status).toBe(503);
    expect(open.headers.get("Retry-After")).toBe(String(CIRCUIT_RETRY_AFTER_S));
    const body = await open.json();
    expect(body.detail).toBe("Backend circuit open");
    expect(body.request_id).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resets the circuit after a successful upstream response", async () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await forwardToBackend("/health", { method: "GET" });
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ok = await forwardToBackend("/health", { method: "GET" });
    expect(ok.status).toBe(200);

    // One more failure should NOT immediately open the circuit.
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const again = await forwardToBackend("/health", { method: "GET" });
    expect(again.status).toBe(502);
  });

  it("echoes request_id on pass-through upstream 5xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await forwardToBackend("/orgs/x/signals", {
      method: "GET",
      requestId: "req-test-123",
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Request-ID")).toBe("req-test-123");
    const body = await res.json();
    expect(body.request_id).toBe("req-test-123");
    expect(body.detail).toBe("boom");
  });

  it("normalises plain-text 'no healthy upstream' 503 into Backend unavailable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("no healthy upstream", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const res = await forwardToBackend("/auth/me", {
      method: "GET",
      requestId: "req-upstream-down",
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(CIRCUIT_RETRY_AFTER_S));
    const body = await res.json();
    expect(body.detail).toBe("Backend unavailable");
    expect(body.upstream_down).toBe(true);
    expect(body.request_id).toBe("req-upstream-down");
  });
});
