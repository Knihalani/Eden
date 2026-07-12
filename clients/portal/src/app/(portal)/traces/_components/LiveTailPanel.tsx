"use client";

/**
 * LiveTailPanel — N11 live trace streaming on /traces.
 * Uses the existing SSE hook + org stream proxy.
 */

import { Pause, Play, Radio, Trash2 } from "lucide-react";
import { useObservabilityStream } from "@/hooks/use-observability-stream";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LiveTailPanelProps {
  orgId: string;
  enabled?: boolean;
  onSelectTrace?: (traceId: string) => void;
}

export function LiveTailPanel({
  orgId,
  enabled = true,
  onSelectTrace,
}: LiveTailPanelProps) {
  const { connected, events, paused, pause, resume, clear } =
    useObservabilityStream({ orgId, maxEvents: 40, enabled });

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
              connected ? "text-[var(--terminal)]" : "text-[var(--text-muted)]",
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Live tail
            </p>
            <p className="text-[10px] text-[var(--text-muted)] truncate">
              {connected
                ? paused
                  ? "Paused — new events held"
                  : "Streaming new traces"
                : "Connecting…"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={paused ? "Resume live tail" : "Pause live tail"}
            onClick={() => (paused ? resume() : pause())}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
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

      {events.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] py-2">
          Waiting for new traces…
        </p>
      ) : (
        <ul className="max-h-48 overflow-y-auto divide-y divide-[var(--border-subtle)]">
          {events.map((ev) => (
            <li key={ev.trace_id}>
              <button
                type="button"
                className="w-full flex items-center justify-between gap-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)] rounded px-1"
                onClick={() => onSelectTrace?.(ev.trace_id)}
              >
                <span className="font-mono text-[11px] text-[var(--text-primary)] truncate">
                  {ev.trace_id.slice(0, 18)}…
                </span>
                <span className="text-[10px] text-[var(--text-muted)] shrink-0">
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
