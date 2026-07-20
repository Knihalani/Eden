// @vitest-environment jsdom
/**
 * Regression test for usePolling's handling of 429 / rate-limit
 * errors.
 *
 * Pre-fix: 429 was lumped in with "generic failures", so a single
 * 429 caused a small (1-2s) exponential backoff and the next tick
 * fired immediately — multi-polling-component dashboards could
 * reach the upstream's rate limiter 50+ times per second during
 * state-flip cascades.
 *
 * Post-fix: 429 puts the poll into a long cooldown (~30s default),
 * every subsequent tick (even on re-arm of the effect) waits for
 * that cooldown to elapse before issuing another request, and the
 * failure does not toggle the auth-error permanent bail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePolling } from "@/hooks/use-polling";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePolling rate-limit handling", () => {
  it("does not fire another tick while the rate-limit cooldown is active", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Rate limit exceeded. Please slow down."))
      .mockResolvedValueOnce("ok");

    renderHook(() =>
      usePolling({
        fetch,
        intervalMs: 5_000,
        deps: [],
      }),
    );

    // The first tick fires synchronously inside start().
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Even after the steady-state interval has elapsed, the rate-
    // limit cooldown keeps us paused.
    await vi.advanceTimersByTimeAsync(10_000);
    // No new request yet.
    expect(fetch).toHaveBeenCalledTimes(1);

    // After the 30s rate-limit default cooldown elapses, the next
    // tick should fire (and succeed). Advance exactly to the
    // cooldown boundary — not past the post-success intervalMs —
    // so we assert one recovery tick, not the steady-state follow-up.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT mark the poll as auth-failed on a 429", async () => {
    const onAuthError = vi.fn();
    const fetch = vi.fn().mockRejectedValue(new Error("HTTP 429 Too Many Requests"));

    renderHook(() =>
      usePolling({
        fetch,
        intervalMs: 1_000,
        deps: [],
        onAuthError,
      }),
    );

    // Run a full cooldown window's worth of timers.
    await vi.advanceTimersByTimeAsync(60_000);
    // 429 is NOT an auth error — the dashboard should not be
    // redirected on a throttle.
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("re-arms after a successful tick at intervalMs (no one-shot stall)", async () => {
    const fetch = vi.fn().mockResolvedValue("ok");

    renderHook(() =>
      usePolling({
        fetch,
        intervalMs: 5_000,
        deps: [],
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
