/**
 * N11 — subscribe to session-scoped live SSE (`/stream/traces/{sessionId}/events`).
 *
 * Reconnect UX mirrors ``useObservabilityStream``: exponential backoff
 * capped at 30s, hard attempt cap, ``failed`` + ``retry()`` so the
 * panel does not sit on an unbounded browser EventSource reconnect
 * loop when the handshake 502s or the upstream stays down.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LiveTraceEvent = {
  type: string;
  event_id?: number;
  span_id?: string;
  name?: string;
  trace_id?: string;
  status?: string;
  step_count?: number;
  [key: string]: unknown;
};

const MAX_RECONNECT_ATTEMPTS = 6;

/** Named SSE ``event: error`` codes that must not silent-reconnect. */
const TERMINAL_ERROR_CODES = new Set([
  "feature_disabled",
  "stream_duration_exceeded",
  "subscribe_failed",
]);

export function useLiveTraceStream(opts: {
  orgId: string | undefined;
  sessionId: string | null | undefined;
  enabled?: boolean;
  maxEvents?: number;
}) {
  const { orgId, sessionId, enabled = true, maxEvents = 200 } = opts;
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const [events, setEvents] = useState<LiveTraceEvent[]>([]);
  const [failed, setFailed] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalErrorRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const clear = useCallback(() => setEvents([]), []);

  const connect = useCallback(() => {
    if (typeof window === "undefined" || !enabled || !orgId || !sessionId) {
      return;
    }

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    terminalErrorRef.current = false;

    // Dedicated long-duration route (maxDuration=300), not catch-all
    // ``/api/proxy`` which caps at 30s and kills quiet live tails.
    const url = `/api/orgs/${encodeURIComponent(orgId)}/stream/traces/${encodeURIComponent(sessionId)}/events`;
    let es: EventSource;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      setFailed(true);
      return;
    }
    esRef.current = es;

    const onAny = (ev: MessageEvent, type: string) => {
      setConnected(true);
      setLive(true);
      let data: LiveTraceEvent = { type };
      try {
        data = { type, ...(JSON.parse(ev.data) as object) };
      } catch {
        /* keep type-only */
      }
      if (type === "error" || data.type === "error") {
        const code = (data as { code?: string }).code;
        if (code && TERMINAL_ERROR_CODES.has(code)) {
          terminalErrorRef.current = true;
          setLive(false);
          setConnected(false);
          setFailed(true);
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          es.close();
          esRef.current = null;
          if (code !== "feature_disabled") {
            setEvents((prev) => {
              const next = [...prev, data];
              return next.length > maxEvents ? next.slice(-maxEvents) : next;
            });
          }
          return;
        }
      }
      if (type === "trace_finalized" || data.type === "trace_finalized") {
        setFinalized(true);
        setLive(false);
      }
      if (type === "ping") return;
      setEvents((prev) => {
        const next = [...prev, data];
        return next.length > maxEvents ? next.slice(-maxEvents) : next;
      });
    };

    es.onopen = () => {
      setConnected(true);
      setLive(true);
      setFailed(false);
      terminalErrorRef.current = false;
      reconnectAttemptsRef.current = 0;
    };
    es.onerror = () => {
      setConnected(false);
      setLive(false);
      // Close before scheduling custom reconnect — browser auto-reconnect
      // would race our backoff (dual reconnect / thundering herd).
      es.close();
      esRef.current = null;
      if (terminalErrorRef.current) {
        setFailed(true);
        return;
      }
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setFailed(true);
        return;
      }
      reconnectAttemptsRef.current = Math.min(
        reconnectAttemptsRef.current + 1,
        MAX_RECONNECT_ATTEMPTS,
      );
      const backoff = Math.min(
        1000 * Math.pow(2, reconnectAttemptsRef.current),
        30_000,
      );
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (enabledRef.current) connect();
      }, backoff);
    };
    for (const t of [
      "span_start",
      "span_update",
      "span_end",
      "stumble_detected",
      "trace_finalized",
      "error",
      "ping",
    ]) {
      es.addEventListener(t, (ev) => onAny(ev as MessageEvent, t));
    }
    es.onmessage = (ev) => onAny(ev, "message");
  }, [orgId, sessionId, enabled, maxEvents]);

  useEffect(() => {
    if (!enabled || !orgId || !sessionId) {
      setConnected(false);
      setLive(false);
      return;
    }
    setFailed(false);
    setFinalized(false);
    setEvents([]);
    connect();
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setConnected(false);
      setLive(false);
    };
  }, [connect, enabled, orgId, sessionId]);

  const retry = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    terminalErrorRef.current = false;
    setFailed(false);
    connect();
  }, [connect]);

  return { connected, live, finalized, events, failed, clear, retry };
}
