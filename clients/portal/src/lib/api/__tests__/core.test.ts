// @vitest-environment jsdom
/**
 * Regression tests for the F41 API-communication-layer fixes in
 * ``core.ts``:
 *
 *  F41-1: ``fetchApi``'s internal 30s timeout AbortController used to
 *  be silently discarded whenever a caller passed its own ``signal``
 *  (object-spread precedence bug) — the timeout's ``abort()`` became
 *  a no-op with respect to the real outgoing fetch, and any
 *  caller-supplied signal for user-triggered cancellation was equally
 *  ignored unless it happened to be spread last.
 *
 *  F41-4: ``fetchApi`` needed a "raw response" mode so hand-rolled
 *  ``fetch()`` call sites (SSE readers, status-code probes) could
 *  route through the shared auth/timeout/retry pipeline while still
 *  getting the live, unparsed ``Response`` back.
 *
 *  F41-5: the in-flight GET dedup key ignored ``options.stream`` (and
 *  now ``options.raw``) — a JSON-mode and a blob/stream/raw-mode
 *  request to the identical GET URL+body used to collapse into one
 *  shared promise and hand the wrong runtime shape to whichever
 *  caller didn't originate the fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // fetchApi reads the client Clerk session imperatively off
  // `window.Clerk` — leave it undefined so the "attach bearer" branch
  // is a no-op and doesn't affect these tests.
  (window as unknown as { Clerk?: unknown }).Clerk = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchApi — caller signal + internal timeout combination (F41-1)", () => {
  it("aborts the outgoing fetch when the CALLER's signal fires, even though fetchApi also races its own internal timeout controller", async () => {
    const { fetchApi, __resetFetchApiInflightForTests } = await import("../core");
    __resetFetchApiInflightForTests();

    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const callerController = new AbortController();
    const promise = fetchApi("/whatever", {
      noDedup: true,
      signal: callerController.signal,
    });

    // Let the microtask queue drain so doFetch() has actually called
    // fetch() and captured the combined signal.
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    callerController.abort();

    expect(capturedSignal?.aborted).toBe(true);
    await expect(promise).rejects.toThrow();
  });

  it("still enforces the internal 30s timeout when the caller passes their own (never-firing) signal — pre-fix, a caller signal silently discarded the timeout controller", async () => {
    vi.useFakeTimers();
    const { fetchApi, __resetFetchApiInflightForTests } = await import("../core");
    __resetFetchApiInflightForTests();

    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    // A caller signal that itself never fires (e.g. a long-lived
    // AbortController the caller only aborts on unmount).
    const callerController = new AbortController();
    const promise = fetchApi("/whatever", {
      noDedup: true,
      signal: callerController.signal,
    });
    // Swallow the eventual rejection so it doesn't surface as an
    // unhandled rejection warning before we assert on it below.
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(capturedSignal?.aborted).toBe(false);

    // Advance past the 30s internal timeout.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(capturedSignal?.aborted).toBe(true);
    await expect(promise).rejects.toThrow();
  });
});

describe("fetchApi — raw response mode (F41-4)", () => {
  it("returns the live Response instead of parsing the body, without throwing on non-2xx", async () => {
    const { fetchApi, __resetFetchApiInflightForTests } = await import("../core");
    __resetFetchApiInflightForTests();

    fetchMock.mockResolvedValue(jsonResponse(503, { detail: "not configured" }));

    const res = await fetchApi<Response>("/auth/users/me/avatar", {
      method: "POST",
      raw: true,
    });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(503);
    // Body must still be readable by the caller — fetchApi must not
    // have consumed it.
    const body = await res.json();
    expect(body).toEqual({ detail: "not configured" });
  });

  it("still attaches an Authorization bearer header via the shared pipeline in raw mode", async () => {
    const { fetchApi, __resetFetchApiInflightForTests } = await import("../core");
    __resetFetchApiInflightForTests();

    (window as unknown as {
      Clerk?: { session?: { getToken?: () => Promise<string> } };
    }).Clerk = {
      session: { getToken: async () => "tok_123" },
    };

    let capturedHeaders: Headers | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });

    await fetchApi<Response>("/orgs/org_1/ai/chat", {
      method: "POST",
      raw: true,
      stream: true,
    });

    expect(capturedHeaders?.get("authorization")).toBe("Bearer tok_123");
  });
});

describe("fetchApi — in-flight GET dedup keys on stream/raw (F41-5)", () => {
  it("does not collapse a plain JSON GET and a raw-mode GET to the identical URL into one shared promise", async () => {
    const { fetchApi, __resetFetchApiInflightForTests } = await import("../core");
    __resetFetchApiInflightForTests();

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { hello: "world" })));

    const [jsonResult, rawResult] = await Promise.all([
      fetchApi<{ hello: string }>("/orgs/org_1/thing"),
      fetchApi<Response>("/orgs/org_1/thing", { raw: true }),
    ]);

    // Two independent fetches — one per dedup slot — not one shared
    // promise handing a Response to the JSON caller (or vice versa).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jsonResult).toEqual({ hello: "world" });
    expect(rawResult).toBeInstanceOf(Response);
  });

  it("still dedupes two identical plain GETs into a single physical fetch", async () => {
    const { fetchApi, __resetFetchApiInflightForTests } = await import("../core");
    __resetFetchApiInflightForTests();

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { hello: "world" })));

    const [a, b] = await Promise.all([
      fetchApi<{ hello: string }>("/orgs/org_1/thing"),
      fetchApi<{ hello: string }>("/orgs/org_1/thing"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ hello: "world" });
    expect(b).toEqual({ hello: "world" });
  });
});
