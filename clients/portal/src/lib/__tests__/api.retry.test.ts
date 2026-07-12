// @vitest-environment jsdom
/**
 * Regression tests for fetchApi's transient-retry logic.
 *
 * The portal was reported to spam `GET /api/proxy/auth/me` (429
 * Too Many Requests) on every state flip because:
 *   - fetchApi retried 429 up to 2 times inside a single call
 *   - did not honour the upstream's ``Retry-After`` header
 *   - useOrg's usePolling tore down + re-ticked on every `loading`
 *     flip, multiplying the spam
 *
 * These tests pin the new behaviour: cap the in-call 429 retries at
 * 1, sleep at least ``Retry-After`` (or a sane 5s default) before
 * retrying, and never retry a 429 more than once.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ``Clerk`` global is read once via ``refreshClerkToken`` only when
// the response is 401. Stub an empty object so the lookup short-
// circuits cleanly for the 429 tests.
(globalThis as unknown as { window: { Clerk?: unknown } }).window = {
  Clerk: undefined,
};

import { api, ApiError } from "@/lib/api";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// Negative-path tests here intentionally reject the underlying
// fetchApi promise. The fetchApi implementation stores its inflight
// promise in a module-level map *before* any caller .catch attaches,
// which means a microtask-timed rejection can land on an
// unhandled-promise slot for one tick before our catch handler is
// attached. Vitest's default reporter flags that as a synthetic
// "unhandled rejection" warning, even though the test still passes
// and the catch eventually runs. Use `await expect(...).rejects` for
// negative-path assertions so Vitest attaches the catch handler
// synchronously and the linter stays quiet.


describe("fetchApi 429 backoff", () => {
  it("honours Retry-After (delta-seconds) and caps at one retry", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { detail: "rate limited" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "u", email: "", name: "", organizations: [], current_org_id: null }));

    const pending = api.getMe().catch((e) => e);

    // After the first 429 the fetch should not fire again until the
    // Retry-After window has elapsed. Verify by advancing partially
    // and confirming the second fetch has NOT been called.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the 1s Retry-After and let the retry resolve.
    await vi.advanceTimersByTimeAsync(600);
    const result = await pending;
    expect(result).toMatchObject({ user_id: "u" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT call the upstream a third time on a 429", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { detail: "throttled" }, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(429, { detail: "throttled" }, { "Retry-After": "0" }));

    // Negative-path tests in this file intentionally trigger an
    // ApiError rejection from fetchApi. The internal inflight
    // promise map holds the rejected promise for a single microtask
    // tick before any caller-attached catch fires — Vitest's default
    // logger flags that as "unhandled rejection" even though the
    // test always passes. Attach a process-level guard that
    // recognises the expected rejection shape during this test only.
    const expected = { status: 429, detail: "throttled" } as const;
    const handler = (reason: unknown) => {
      if (
        reason instanceof ApiError &&
        reason.status === expected.status &&
        reason.detail === expected.detail
      ) {
        return; // expected, swallow
      }
      // Anything else: re-throw so Vitest still sees real failures.
      throw reason;
    };
    process.on("unhandledRejection", handler);
    try {
      const assertion = expect(api.getMe()).rejects.toBeInstanceOf(ApiError);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      // Exactly two requests — the original plus the single
      // permitted retry, never a third.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("falls back to a 5s default when Retry-After is missing", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { detail: "throttled" }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "u", email: "", name: "", organizations: [], current_org_id: null }));

    const pending = api.getMe().catch((e) => e);

    // Even after a few seconds the retry should not have fired
    // because we should default to a 5s cooldown.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(800);
    const result = await pending;
    expect(result).toMatchObject({ user_id: "u" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still applies general 2-retry backoff for 5xx responses", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(502, { detail: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(502, { detail: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "u", email: "", name: "", organizations: [], current_org_id: null }));

    const promise = api.getMe();
    // Run out the timers + microtasks.
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result).toMatchObject({ user_id: "u" });
    // 1 + up to 2 retries for 502
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("does NOT retry proxy 502 Backend unreachable (LP-21)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(502, { detail: "Backend unreachable", request_id: "r1" }),
    );

    const handler = (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 502) return;
      throw reason;
    };
    process.on("unhandledRejection", handler);
    try {
      await expect(api.getMe()).rejects.toBeInstanceOf(ApiError);
      // Exactly one request — no amplification against a dead upstream.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("does NOT retry proxy 502 Backend timed out (LP-21)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(502, { detail: "Backend timed out", request_id: "r2" }),
    );

    const handler = (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 502) return;
      throw reason;
    };
    process.on("unhandledRejection", handler);
    try {
      await expect(api.getMe()).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});
