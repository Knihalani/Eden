// @vitest-environment jsdom
/**
 * Wave 9.4 — live session SSE reconnect cap + terminal error UX.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLiveTraceStream } from "@/hooks/use-live-trace-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
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

async function exhaustReconnectAttempts(errorCount: number) {
  for (let i = 0; i < errorCount; i++) {
    const current =
      FakeEventSource.instances[FakeEventSource.instances.length - 1];
    current.emitError();
    await vi.advanceTimersByTimeAsync(30_000);
  }
}

const ERRORS_TO_EXHAUST_CAP = 7;

describe("useLiveTraceStream reconnect UX", () => {
  it("surfaces failed after reconnect cap and stops opening sources", async () => {
    const { result } = renderHook(() =>
      useLiveTraceStream({ orgId: "org_1", sessionId: "sess_1" }),
    );

    expect(result.current.failed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      await exhaustReconnectAttempts(ERRORS_TO_EXHAUST_CAP);
    });

    expect(result.current.failed).toBe(true);
    const openedAtCap = FakeEventSource.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeEventSource.instances).toHaveLength(openedAtCap);
  });

  it("retry() resets the attempt counter and reopens", async () => {
    const { result } = renderHook(() =>
      useLiveTraceStream({ orgId: "org_1", sessionId: "sess_1" }),
    );

    await act(async () => {
      await exhaustReconnectAttempts(ERRORS_TO_EXHAUST_CAP);
    });
    expect(result.current.failed).toBe(true);
    const before = FakeEventSource.instances.length;

    act(() => {
      result.current.retry();
    });

    expect(result.current.failed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });

  it("named feature_disabled error sets failed and does not reconnect", async () => {
    const { result } = renderHook(() =>
      useLiveTraceStream({ orgId: "org_1", sessionId: "sess_1" }),
    );
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emitNamed(
        "error",
        JSON.stringify({ code: "feature_disabled", message: "off" }),
      );
    });

    expect(result.current.failed).toBe(true);
    expect(result.current.live).toBe(false);
    expect(source.closed).toBe(true);

    const openedAfter = FakeEventSource.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeEventSource.instances).toHaveLength(openedAfter);
  });
});
