// @vitest-environment jsdom
/**
 * Regression tests for fetchApi's stream-handshake retry on 429.
 *
 * Pre-fix: ``stream: true`` requests skipped every retry branch in
 * fetchApi because SSE is long-lived. But the *connect-time*
 * handshake is a normal HTTP GET — when the gateway returned 429
 * before the stream opened, the consumer saw a raw ApiError without
 * any backoff, and surrounding polling loops (useObservabilityStream)
 * would re-dial repeatedly during the same throttle window.
 *
 * Post-fix: a stream handshake that returns 429 waits the upstream's
 * ``Retry-After`` (or a 5 s default) and re-issues exactly once.
 * Once that retry returns (success or hard error), we fall through
 * to the standard body-read. The same path is exercised by
 * ``api.exportOrgData`` (one-shot zip), so the regression pinning
 * here covers the export download during a throttle too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

(globalThis as unknown as { window: { Clerk?: unknown } }).window = {
  Clerk: undefined,
};

import { api, ApiError } from "@/lib/api";

// jsdom already ships URL.createObjectURL but the anchor.click()
// handler isn't useful in tests; swap in deterministic stubs so
// exportOrgData's DOM side effects don't interfere with the
// network-shape assertions below.
function stubDownloadSideEffects(): void {
  let i = 0;
  URL.createObjectURL = (() => `blob:test-${i++}`) as typeof URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () {
    /* no-op */
  };
}

function streamResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/zip", ...headers },
  });
}

function jsonError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  stubDownloadSideEffects();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchApi stream-handshake 429 retry", () => {
  it("retries once after Retry-After=0 and surfaces the stream body", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonError(429, { detail: "throttled" }, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(streamResponse(200, "ZIPBYTES"));

    // exportOrgData fires a real download via DOM; stubbed above
    // so the only observable behaviour is the network shape.
    const promise = api.exportOrgData("org-1");
    await vi.advanceTimersByTimeAsync(50);
    await promise;
    // Two fetches: the throttled handshake + the successful retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the 5s default cooldown when Retry-After is absent", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonError(429, { detail: "throttled" }))
      .mockResolvedValueOnce(streamResponse(200, "ZIPBYTES"));

    const promise = api.exportOrgData("org-1");
    // After 4.5s the retry must still be pending.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // After ~5s total, the retry fires.
    await vi.advanceTimersByTimeAsync(800);
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry beyond the single handshake attempt", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonError(429, { detail: "throttled" }, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(
        jsonError(429, { detail: "throttled" }),
      );

    // fetchApi only retries the stream handshake ONCE; further
    // upstream 429s propagate as a clean ApiError so the consumer
    // (SSE hook, export button) can surface them without a retry
    // loop on top. exportOrgData's consumer chain attaches its
    // catch after a microtask — fetchApi's IIFE throws
    // synchronously inside it, so attach a process-level guard
    // to swallow the expected rejection shape.
    let caught: ApiError | undefined;
    const handler = (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 429) {
        caught = reason;
        return;
      }
      throw reason;
    };
    process.on("unhandledRejection", handler);
    try {
      const inner = api.exportOrgData("org-1");
      const promise = inner.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(50);
      const result = (await promise) as ApiError;
      const resultIsApiError = result instanceof ApiError;
      expect(resultIsApiError).toBe(true);
      expect((result as ApiError).status).toBe(429);
      // Two fetches: original handshake + one permitted retry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // TS narrows `caught` to `undefined` because the handler is
      // not invoked in this synchronous test frame; the read below
      // therefore needs an explicit annotation.
      const observedStatus: number =
        (caught?.status ?? (result as ApiError).status) as number;
      expect(observedStatus).toBe(429);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});
