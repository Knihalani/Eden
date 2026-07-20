// @vitest-environment jsdom
/**
 * Phase 4 (perf/bandwidth pass) regression test for the SSE reconnect
 * cap in ``useObservabilityStream``.
 *
 * Pre-fix: once the reconnect cap (``MAX_RECONNECT_ATTEMPTS``) was
 * hit, the hook silently closed the ``EventSource`` and went quiet —
 * the panel just sat on "Connecting…" forever with no signal that
 * the stream had given up and no way to get it back short of a full
 * page reload.
 *
 * Post-fix: the hook exposes `failed` (true once the cap is hit) and
 * `retry()` (resets the attempt counter and reopens the connection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useObservabilityStream } from "@/hooks/use-observability-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  close() {
    this.closed = true;
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emitNamed(type: string, data: string) {
    const ev = new MessageEvent(type, { data });
    for (const cb of this.listeners[type] ?? []) {
      cb(ev);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Advance past every reconnect backoff (capped at 30s each) at once.
 *
 * The cap check in the hook runs *before* the attempt counter is
 * incremented, so the terminal close doesn't land until the
 * (MAX_RECONNECT_ATTEMPTS + 1)-th error — the first six errors each
 * still schedule (and complete) a reconnect.
 */
async function exhaustReconnectAttempts(errorCount: number) {
  for (let i = 0; i < errorCount; i++) {
    const current = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    current.emitError();
    // Backoff is 1000 * 2^attempt, capped at 30s — 30s always clears it.
    await vi.advanceTimersByTimeAsync(30_000);
  }
}

// MAX_RECONNECT_ATTEMPTS is 6 (see use-observability-stream.ts); the
// 7th error is what actually trips the `failed` cap.
const ERRORS_TO_EXHAUST_CAP = 7;

describe("useObservabilityStream reconnect cap", () => {
  it("surfaces `failed` once the reconnect cap is exhausted and stops opening new sources", async () => {
    const { result } = renderHook(() => useObservabilityStream({ orgId: "org_1" }));

    expect(result.current.failed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      await exhaustReconnectAttempts(ERRORS_TO_EXHAUST_CAP);
    });

    expect(result.current.failed).toBe(true);
    // No further sources opened past the cap.
    const openedAtCap = FakeEventSource.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeEventSource.instances).toHaveLength(openedAtCap);
  });

  it("retry() resets the attempt counter and reopens the connection", async () => {
    const { result } = renderHook(() => useObservabilityStream({ orgId: "org_1" }));

    await act(async () => {
      await exhaustReconnectAttempts(ERRORS_TO_EXHAUST_CAP);
    });
    expect(result.current.failed).toBe(true);
    const countBeforeRetry = FakeEventSource.instances.length;

    act(() => {
      result.current.retry();
    });

    expect(result.current.failed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(countBeforeRetry + 1);

    // Simulating a clean open should clear `failed` and reset the
    // attempt counter so a fresh cap of 6 more failures is available.
    act(() => {
      FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen?.();
    });
    expect(result.current.failed).toBe(false);
  });

  it("named SSE event: error sets failed and does not reconnect", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useObservabilityStream({ orgId: "org_1", onError }),
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emitNamed(
        "error",
        JSON.stringify({ code: "redis_unavailable", message: "offline" }),
      );
    });

    expect(result.current.failed).toBe(true);
    expect(result.current.connected).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);

    const openedAfter = FakeEventSource.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeEventSource.instances).toHaveLength(openedAfter);
  });
});
