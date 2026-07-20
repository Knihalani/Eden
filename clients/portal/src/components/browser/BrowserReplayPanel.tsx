"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, MonitorPlay } from "lucide-react";
import { browserSessionsApi } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Props = {
  orgId: string;
  traceId: string;
  activeStep?: number;
};

type RrwebEvent = Record<string, unknown> & { type?: number; timestamp?: number; data?: unknown };

const RRWEB_CHANNEL = "eden-rrweb";

function buildReplaySrcDoc(origin: string): string {
  const umdSrc = `${origin}/api/rrweb-player/rrweb-player.umd.min.cjs`;
  const cssHref = `${origin}/api/rrweb-player/style.css`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="dark light"/>
<link rel="stylesheet" href="${cssHref}"/>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0c; }
  #root { width: 100%; min-height: 360px; }
</style>
</head>
<body>
<div id="root"></div>
<script src="${umdSrc}"><\/script>
<script>
(function () {
  var CHANNEL = ${JSON.stringify(RRWEB_CHANNEL)};
  var player = null;
  var root = document.getElementById("root");
  var mod = window.rrwebPlayer;
  var Ctor = mod && (mod.default || mod.Player || mod);
  function destroy() {
    try { if (player && player.$destroy) player.$destroy(); } catch (e) {}
    player = null;
    if (root) root.innerHTML = "";
  }
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.channel !== CHANNEL) return;
    if (ev.source !== parent) return;
    if (data.type === "init") {
      destroy();
      if (typeof Ctor !== "function" || !root) return;
      try {
        player = new Ctor({
          target: root,
          props: {
            events: data.events || [],
            width: data.width || 640,
            height: data.height || 360,
            autoPlay: false,
            showController: true,
          },
        });
      } catch (e) {}
    } else if (data.type === "goto" && player && player.goto) {
      try { player.goto(data.ms); } catch (e) {}
    } else if (data.type === "destroy") {
      destroy();
    }
  });
  parent.postMessage({ channel: CHANNEL, type: "ready" }, "*");
})();
<\/script>
</body>
</html>`;
}

/**
 * F09 / K10 — rrweb-player stays out of the parent first-load graph.
 * Replay loads UMD + CSS only inside a srcDoc iframe via `/api/rrweb-player/*`
 * with sandbox="allow-scripts" (opaque unique origin) so recorded DOM/script
 * cannot touch the parent. Parent ↔ player via postMessage only.
 */
export function BrowserReplayPanel({ orgId, traceId, activeStep }: Props) {
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrubStep, setScrubStep] = useState(activeStep ?? 0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState<string>("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeReadyRef = useRef(false);
  const pendingInitRef = useRef<{
    events: RrwebEvent[];
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    browserSessionsApi
      .replayForTrace(orgId, traceId)
      .then((res: Record<string, unknown>) => {
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

  const postToPlayer = (msg: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ channel: RRWEB_CHANNEL, ...msg }, "*");
  };

  const sendInit = (payload: { events: RrwebEvent[]; width: number; height: number }) => {
    postToPlayer({ type: "init", ...payload });
  };

  useEffect(() => {
    if (flatEvents.length === 0) return;

    let cancelled = false;
    setPlayerError(null);
    iframeReadyRef.current = false;
    pendingInitRef.current = null;

    try {
      // K10: parent must not import rrweb-player — iframe loads UMD only.
      const origin = window.location.origin;
      const width = iframeRef.current?.clientWidth || 640;
      pendingInitRef.current = {
        events: flatEvents,
        width,
        height: 360,
      };
      setSrcDoc(buildReplaySrcDoc(origin));
    } catch (err) {
      if (!cancelled) {
        setPlayerError(err instanceof Error ? err.message : "Failed to load rrweb player");
      }
    }

    return () => {
      cancelled = true;
      try {
        postToPlayer({ type: "destroy" });
      } catch {
        /* ignore */
      }
      pendingInitRef.current = null;
      iframeReadyRef.current = false;
    };
    // postToPlayer closes over iframeRef; intentional for teardown only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatEvents]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || data.channel !== RRWEB_CHANNEL) return;
      if (data.type !== "ready") return;
      // Opaque sandbox origin is "null"; bind by source window, not origin string.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      iframeReadyRef.current = true;
      const pending = pendingInitRef.current;
      if (pending) {
        sendInit(pending);
        pendingInitRef.current = null;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stepKeys.length === 0 || !iframeReadyRef.current) return;
    const eventsAt = eventsByStep[String(scrubStep)] as RrwebEvent[] | undefined;
    const ts = eventsAt?.[0]?.timestamp;
    if (typeof ts === "number") {
      try {
        postToPlayer({ type: "goto", ms: ts });
      } catch {
        /* ignore scrub errors */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <Link href="/settings?tab=api-keys">Connect browser instrumentation</Link>
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
        <iframe
          ref={iframeRef}
          title="Browser session replay"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="w-full min-h-[360px] rounded border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] overflow-hidden"
        />
      )}
    </Card>
  );
}
