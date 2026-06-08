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
 */

import * as React from "react";

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
}

export function useObservabilityStream({
  orgId,
  maxEvents = 100,
  enabled = true,
  onError,
}: UseObservabilityStreamOptions) {
  const [events, setEvents] = React.useState<LiveTrace[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [lastEventId, setLastEventId] = React.useState<string | null>(null);
  const reconnectAttemptsRef = React.useRef(0);
  const sourceRef = React.useRef<EventSource | null>(null);
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = React.useCallback(() => {
    if (typeof window === "undefined" || !enabled) return;

    // Clean up any prior source.
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    const params = new URLSearchParams();
    if (lastEventId) params.set("last_event_id", lastEventId);
    const qs = params.toString();
    const url = `/api/orgs/${orgId}/observability/stream${qs ? `?${qs}` : ""}`;

    const source = new EventSource(url, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    source.addEventListener("trace", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as LiveTrace;
        if ((e as MessageEvent).lastEventId) {
          setLastEventId((e as MessageEvent).lastEventId);
        }
        setEvents((prev) => {
          if (prev.find((t) => t.trace_id === data.trace_id)) return prev;
          return [data, ...prev].slice(0, maxEvents);
        });
      } catch (err) {
        // ignore malformed event
      }
    });

    source.addEventListener("ping", () => {
      // Keep-alive; do nothing.
    });

    source.onerror = (err) => {
      setConnected(false);
      onError?.(err);
      // EventSource auto-reconnects, but if the connection is
      // permanently broken (server gone) the browser keeps
      // hammering. Cap with explicit backoff.
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectAttemptsRef.current = Math.min(reconnectAttemptsRef.current + 1, 6);
      const backoff = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30_000);
      reconnectTimerRef.current = setTimeout(() => {
        if (enabled) connect();
      }, backoff);
    };
  }, [orgId, lastEventId, maxEvents, enabled, onError]);

  React.useEffect(() => {
    if (!enabled) return;
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

  return {
    connected: connected && enabled && !paused,
    events: paused ? events : events,
    paused,
    pause,
    resume,
    clear,
  };
}
