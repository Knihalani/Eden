/**
 * N11 — subscribe to session-scoped live SSE (`/stream/traces/{sessionId}/events`).
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

  const clear = useCallback(() => setEvents([]), []);

  useEffect(() => {
    if (!enabled || !orgId || !sessionId) {
      setConnected(false);
      setLive(false);
      return;
    }
    setFailed(false);
    setFinalized(false);
    const url = `/api/proxy/orgs/${encodeURIComponent(orgId)}/stream/traces/${encodeURIComponent(sessionId)}/events`;
    let es: EventSource;
    try {
      es = new EventSource(url);
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
        if ((data as { code?: string }).code === "feature_disabled") {
          setLive(false);
          setConnected(false);
          es.close();
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
    };
    es.onerror = () => {
      setConnected(false);
      if (es.readyState === EventSource.CLOSED) setFailed(true);
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

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
      setLive(false);
    };
  }, [orgId, sessionId, enabled, maxEvents]);

  return { connected, live, finalized, events, failed, clear };
}
