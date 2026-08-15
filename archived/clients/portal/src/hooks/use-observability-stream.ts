"use client";

/**
 * useObservabilityStream — SSE-based live trace tail.
 *
 * Phase 7.2 (C3): subscribes to the /orgs/{org}/observability/stream
 * SSE endpoint and accumulates new trace events as they arrive. The
 * hook returns:
 *   - connected: boolean, true when the EventSource is open
 *   - events: array of trace summaries (FIFO, capped at `maxEvents`)
 *   - paused: boolean (when true, no new events are added)
 *   - pause()/resume(): control the connection
 *   - clear(): empty the events array
 *
 * Auto-reconnects on disconnect with exponential backoff capped at
 * 30s. Last-Event-ID resume is supported — the backend re-sends
 * missed events when the client reconnects.
 *
 * Phase 4 (perf/bandwidth pass): once the reconnect cap is hit the
 * hook used to close the source and go silent — the panel just sat
 * on "Connecting…" forever with no way to tell the user the stream
 * had actually given up, and no way to get it back short of a full
 * page reload. `failed` surfaces that terminal state and `retry()`
 * resets the attempt counter and reopens the connection.
 */

import * as React from "react";

/**
 * Hard cap on reconnect attempts (PQ-6). After the cap the
 * EventSource is closed and the parent component stops trying.
 * 6 was chosen empirically — covers the typical mobile-network
 * drop pattern (~3-4 quick disconnects on a subway commute) while
 * bounding the wasted worker time when the upstream is permanently
 * down. Pre-fix the browser's default reconnect behaviour was
 * unbounded: a single broken backend could rack up 1000+ socket
 * attempts per minute per open tab.
 */
const MAX_RECONNECT_ATTEMPTS = 6;

export interface LiveTrace {
  trace_id: string;
  realm: string;
  agent_id: string | null;
  started_at: string | null;
  outcome: string | null;
  span_count: number;
  duration_ms: number;
  streaming_metrics?: {
    ttft_ms: number | null;
    itl_ms_avg: number | null;
    tpot_ms: number | null;
  } | null;
}

interface UseObservabilityStreamOptions {
  orgId: string;
  maxEvents?: number;
  enabled?: boolean;
  onError?: (err: Event) => void;
  /** Called when a ``notification:new`` SSE event arrives on this org's
   *  stream. Use this to trigger a notifications refresh without opening
   *  a second EventSource connection. */
  onNotification?: (data: unknown) => void;
}

export function useObservabilityStream({
  orgId,
  maxEvents = 100,
  enabled = true,
  onError,
  onNotification }: UseObservabilityStreamOptions) {
  const [events, setEvents] = React.useState<LiveTrace[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // lastEventId lives in a ref so reconnect URL can resume via
  // Last-Event-ID without putting it in connect's useCallback deps
  // (state updates would recreate EventSource on every event).
  const lastEventIdRef = React.useRef<string | null>(null);
  const reconnectAttemptsRef = React.useRef(0);
  const sourceRef = React.useRef<EventSource | null>(null);
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Terminal BE ``event: error`` (redis_unavailable, last_event_id_too_old)
  // must not fall through to the connection onerror reconnect loop.
  const terminalErrorRef = React.useRef(false);
  const pausedRef = React.useRef(false);
  pausedRef.current = paused;
  // PQ-5: capture onError via ref so the ``connect`` useCallback
  // doesn't tear down + reopen the EventSource every time the
  // parent passes a fresh closure. Same pattern as usePolling.
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  // Same pattern for onNotification — keep connect() stable.
  const onNotificationRef = React.useRef(onNotification);
  onNotificationRef.current = onNotification;

  const connect = React.useCallback(() => {
    if (typeof window === "undefined" || !enabled) return;

    // Clean up any prior source.
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    terminalErrorRef.current = false;

    const params = new URLSearchParams();
    if (lastEventIdRef.current) {
      params.set("last_event_id", lastEventIdRef.current);
    }
    const qs = params.toString();
    const url = `/api/orgs/${orgId}/observability/stream${qs ? `?${qs}` : ""}`;

    const source = new EventSource(url, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      setFailed(false);
      terminalErrorRef.current = false;
      reconnectAttemptsRef.current = 0;
    };

    source.addEventListener("trace", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as LiveTrace;
        if ((e as MessageEvent).lastEventId) {
          lastEventIdRef.current = (e as MessageEvent).lastEventId;
        }
        setEvents((prev) => {
          // Skip buffer updates while paused so "pause" freezes the view.
          if (pausedRef.current) return prev;
          if (prev.find((t) => t.trace_id === data.trace_id)) return prev;
          return [data, ...prev].slice(0, maxEvents);
        });
      } catch (_err) {
        // ignore malformed event
      }
    });

    source.addEventListener("ping", () => {
      // Keep-alive; do nothing.
    });

    // notification:new — backend publishes this when a portal
    // notification row is inserted. The payload is opaque; callers
    // use the onNotification callback to trigger a refresh.
    source.addEventListener("notification:new", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as unknown;
        onNotificationRef.current?.(data);
      } catch (_err) {
        // ignore malformed event
      }
    });

    // Named SSE ``event: error`` from the backend (e.g. redis_unavailable,
    // last_event_id_too_old). These are terminal — fail open to REST,
    // do not silent-reconnect. Distinguish from connection-level errors
    // via MessageEvent.data presence.
    source.addEventListener("error", (e) => {
      const me = e as MessageEvent;
      if (typeof me.data !== "string" || me.data.length === 0) return;
      terminalErrorRef.current = true;
      setConnected(false);
      setFailed(true);
      onErrorRef.current?.(e);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      source.close();
      sourceRef.current = null;
    });

    source.onerror = (err) => {
      setConnected(false);
      // Read via ref so a fresh onError closure doesn't invalidate
      // the connect useCallback identity (PQ-5).
      onErrorRef.current?.(err);
      // Close before scheduling custom reconnect. Leaving the source
      // open lets the browser's built-in EventSource auto-reconnect
      // race our backoff timer (dual reconnect / thundering herd).
      source.close();
      sourceRef.current = null;
      // BE named ``event: error`` already marked terminal — do not
      // treat the subsequent close as a transient disconnect.
      if (terminalErrorRef.current) {
        setFailed(true);
        return;
      }
      // PQ-6: cap reconnect attempts. Without a hard close the
      // browser keeps hammering indefinitely when upstream is down.
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setFailed(true);
        return;
      }
      reconnectAttemptsRef.current = Math.min(
        reconnectAttemptsRef.current + 1,
        MAX_RECONNECT_ATTEMPTS,
      );
      const backoff = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30_000);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (enabled) connect();
      }, backoff);
    };
  }, [orgId, maxEvents, enabled]);

  React.useEffect(() => {
    if (!enabled) return;
    // Drop prior-org buffer + resume cursor before reconnect so a
    // switch never replays another tenant's Last-Event-ID or events.
    setEvents([]);
    lastEventIdRef.current = null;
    connect();
    return () => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [connect, enabled]);

  const pause = React.useCallback(() => setPaused(true), []);
  const resume = React.useCallback(() => setPaused(false), []);
  const clear = React.useCallback(() => setEvents([]), []);

  /** Manual retry after the reconnect cap gives up. Resets the
   *  attempt counter (a fresh user action, not another automatic
   *  hammering) and re-dials immediately. */
  const retry = React.useCallback(() => {
    reconnectAttemptsRef.current = 0;
    terminalErrorRef.current = false;
    setFailed(false);
    connect();
  }, [connect]);

  return {
    connected: connected && enabled && !paused,
    events,
    paused,
    failed,
    pause,
    resume,
    clear,
    retry };
}
