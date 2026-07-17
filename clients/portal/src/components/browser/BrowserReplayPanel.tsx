"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, MonitorPlay } from "lucide-react";
import RrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import { browserSessionsApi } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Props = {
  orgId: string;
  traceId: string;
  activeStep?: number;
};

type RrwebEvent = Record<string, unknown> & { type?: number; timestamp?: number; data?: unknown };

/**
 * F09 — real rrweb-player (npm; plan name @rrweb/player). Replaces JSON iframe.
 */
export function BrowserReplayPanel({ orgId, traceId, activeStep }: Props) {
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrubStep, setScrubStep] = useState(activeStep ?? 0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<{ $destroy?: () => void; goto?: (ms: number) => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    browserSessionsApi
      .replayForTrace(orgId, traceId)
      .then((res) => {
        if (!cancelled) setBundle(res);
      })
      .catch(() => {
        if (!cancelled) setBundle(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, traceId]);

  useEffect(() => {
    if (activeStep != null) setScrubStep(activeStep);
  }, [activeStep]);

  const eventsByStep = useMemo(() => {
    const raw = bundle?.events_by_step;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown[]>) : {};
  }, [bundle]);

  const flatEvents = useMemo((): RrwebEvent[] => {
    if (Array.isArray(bundle?.events)) return bundle!.events as RrwebEvent[];
    if (Array.isArray(bundle?.rrweb_events)) return bundle!.rrweb_events as RrwebEvent[];
    const merged: RrwebEvent[] = [];
    for (const key of Object.keys(eventsByStep).sort((a, b) => Number(a) - Number(b))) {
      const chunk = eventsByStep[key];
      if (Array.isArray(chunk)) merged.push(...(chunk as RrwebEvent[]));
    }
    return merged;
  }, [bundle, eventsByStep]);

  const stepKeys = useMemo(
    () =>
      Object.keys(eventsByStep)
        .map((k) => Number(k))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b),
    [eventsByStep],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || flatEvents.length === 0) return;

    setPlayerError(null);
    host.innerHTML = "";

    try {
      const player = new RrwebPlayer({
        target: host,
        props: {
          events: flatEvents,
          width: host.clientWidth || 640,
          height: 360,
          autoPlay: false,
          showController: true,
        },
      }) as { $destroy?: () => void; goto?: (ms: number) => void };
      playerRef.current = player;
    } catch (err) {
      setPlayerError(err instanceof Error ? err.message : "Failed to load rrweb player");
    }

    return () => {
      try {
        playerRef.current?.$destroy?.();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (host) host.innerHTML = "";
    };
  }, [flatEvents]);

  useEffect(() => {
    if (stepKeys.length === 0 || !playerRef.current?.goto) return;
    const eventsAt = eventsByStep[String(scrubStep)] as RrwebEvent[] | undefined;
    const ts = eventsAt?.[0]?.timestamp;
    if (typeof ts === "number") {
      try {
        playerRef.current.goto(ts);
      } catch {
        /* ignore scrub errors */
      }
    }
  }, [scrubStep, stepKeys, eventsByStep]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] p-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading browser replay…
      </div>
    );
  }

  if (!bundle) {
    return (
      <Card padding="md" className="text-sm text-[var(--text-muted)] space-y-2">
        <p>
          No browser recording for this trace. Instrument your app with the Eden browser recorder
          to sync RRWeb events to the timeline.
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings?tab=sdk">Connect browser instrumentation</Link>
        </Button>
      </Card>
    );
  }

  if (flatEvents.length === 0) {
    return (
      <Card padding="md" className="text-sm text-[var(--text-muted)]">
        Recording metadata found but no RRWeb events to play.
      </Card>
    );
  }

  return (
    <Card padding="md" className="space-y-3" data-testid="browser-replay-panel">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MonitorPlay className="h-4 w-4 text-[var(--accent)]" />
        Browser replay
        <span className="text-xs text-[var(--text-muted)] font-normal">
          {(bundle.session as { event_count?: number })?.event_count ?? flatEvents.length} events
        </span>
      </div>

      {stepKeys.length > 0 && (
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Replay scrubber">
          {stepKeys.map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => setScrubStep(step)}
              className={`text-[10px] px-2 py-0.5 rounded border ${
                scrubStep === step
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border-subtle)] text-[var(--text-muted)]"
              }`}
            >
              step {step}
            </button>
          ))}
        </div>
      )}

      {playerError ? (
        <p className="text-xs text-[var(--error)]">{playerError}</p>
      ) : (
        <div
          ref={hostRef}
          className="w-full min-h-[360px] rounded border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] overflow-hidden"
        />
      )}
    </Card>
  );
}
