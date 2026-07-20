"use client";

/**
 * LiveTailPanel — N11 live trace streaming on /traces.
 * Uses the existing SSE hook + org stream proxy.
 * Default off (K6); pauses when the document is hidden.
 */

import { Pause, Play, Radio, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useObservabilityStream } from "@/hooks/use-observability-stream";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LiveTailPanelProps {
  orgId: string;
  /** When omitted, stream starts off until the user clicks Start. */
  enabled?: boolean;
  onSelectTrace?: (traceId: string) => void;
}

export function LiveTailPanel({
  orgId,
  enabled: enabledProp,
  onSelectTrace,
}: LiveTailPanelProps) {
  const [userEnabled, setUserEnabled] = useState(enabledProp ?? false);
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    if (enabledProp !== undefined) setUserEnabled(enabledProp);
  }, [enabledProp]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const streamEnabled = userEnabled && visible;
  const { connected, events, paused, failed, pause, resume, clear, retry } =
    useObservabilityStream({ orgId, maxEvents: 40, enabled: streamEnabled });
  const listRef = useRef<HTMLUListElement>(null);
  const prevLen = useRef(events.length);

  useEffect(() => {
    if (events.length > prevLen.current && listRef.current) {
      listRef.current.classList.remove("live-append-pulse");
      void listRef.current.offsetWidth;
      listRef.current.classList.add("live-append-pulse");
    }
    prevLen.current = events.length;
  }, [events.length]);

  const statusText = !userEnabled
    ? "Off — start to stream"
    : !visible
      ? "Paused while tab hidden"
      : failed
        ? "Connection lost — giving up"
        : connected
          ? paused
            ? "Paused — new events held"
            : events.length === 0
              ? "Live tail idle — waiting for first ingest"
              : "Streaming new traces"
          : "Connecting…";

  return (
    <section
      className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-3 space-y-2"
      aria-label="Live trace tail"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Radio
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              failed
                ? "text-[var(--error)]"
                : connected
                  ? "text-[var(--terminal)]"
                  : "text-[var(--text-muted)]",
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Live tail
            </p>
            <p
              className={cn(
                "text-2xs truncate",
                failed ? "text-[var(--error)]" : "text-[var(--text-muted)]",
              )}
            >
              {statusText}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!userEnabled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Start live tail"
              onClick={() => setUserEnabled(true)}
            >
              <Play className="h-3.5 w-3.5" />
              Start
            </Button>
          ) : failed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={retry}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={paused ? "Resume live tail" : "Pause live tail"}
              onClick={() => (paused ? resume() : pause())}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Clear live tail"
            onClick={clear}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {!userEnabled ? (
        <p className="text-xs text-[var(--text-muted)] py-2">
          Live streaming is off by default. Click Start when you need a live feed.
        </p>
      ) : failed ? (
        <p className="text-xs text-[var(--text-muted)] py-2">
          Gave up after repeated reconnect failures. Click Retry to reconnect.
        </p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] py-2">
          {connected
            ? "Live tail idle — waiting for first ingest."
            : "Waiting for ingest — gateway, SDK, or eden-doctor (`eden.doctor`)."}
        </p>
      ) : (
        <ul
          ref={listRef}
          className="max-h-48 overflow-y-auto divide-y divide-[var(--border-subtle)]"
        >
          {events.map((ev) => (
            <li key={ev.trace_id}>
              <button
                type="button"
                className="w-full flex items-center justify-between gap-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)] rounded px-1"
                onClick={() => onSelectTrace?.(ev.trace_id)}
              >
                <span className="font-mono text-2xs text-[var(--text-primary)] truncate">
                  {ev.trace_id.slice(0, 18)}…
                </span>
                <span className="text-2xs text-[var(--text-muted)] shrink-0">
                  {ev.outcome ?? "—"} · {ev.span_count} spans
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
