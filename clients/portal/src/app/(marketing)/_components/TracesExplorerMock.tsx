"use client";

import { useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import { cn } from "@/lib/utils";
import { TRACE_MOCK_SPANS } from "./marketing-data";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Stylized Traces explorer: span tree, model, latency, cost,
 * one failed eval, quiet Improve affordance. All rows render immediately
 * (SSR / reduced-motion safe); optional staggered opacity only when motion is OK.
 */
export function TracesExplorerMock() {
  const reducedMotion = usePrefersReducedMotion();
  const [motionReady, setMotionReady] = useState(false);

  useEffect(() => {
    if (reducedMotion) {
      setMotionReady(false);
      return;
    }
    const handle = requestAnimationFrame(() => setMotionReady(true));
    return () => cancelAnimationFrame(handle);
  }, [reducedMotion]);

  return (
    <div className="lg:col-span-7 w-full order-2 min-w-0">
      <div
        className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg overflow-hidden shadow-[var(--shadow-sm,0_1px_0_rgba(255,255,255,0.03)_inset)]"
        role="img"
        aria-label="Traces explorer preview: span tree with model, latency, cost, a failed eval, and an Improve patch draft"
      >
        <div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
          <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Traces
          </span>
          <span className="text-[11px] font-mono text-[var(--text-secondary)] truncate">
            trace_8a3f…d1b
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              {!reducedMotion && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--terminal)] opacity-70 animate-ping" />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
            </span>
            live
          </span>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_4rem] sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_4.5rem] gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/60 text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--text-muted)]">
          <span>Span</span>
          <span className="text-right hidden sm:block">Model</span>
          <span className="text-right">Latency</span>
          <span className="text-right">Cost</span>
        </div>

        <div className="p-2 sm:p-3 flex flex-col gap-0.5 min-h-[240px] sm:min-h-[260px] font-mono text-[12px] sm:text-[13px]">
          {TRACE_MOCK_SPANS.map((span, index) => (
            <div
              key={span.id}
              className="flex flex-col gap-0.5"
              style={
                !reducedMotion && motionReady
                  ? {
                      animation: `fade-slide-up 280ms var(--ease-out, cubic-bezier(0.33, 1, 0.68, 1)) both`,
                      animationDelay: `${index * 70}ms`,
                    }
                  : undefined
              }
            >
              <div
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_4.25rem_4rem] sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_4.5rem] gap-1.5 sm:gap-2 items-center px-2 py-1.5 sm:py-2 rounded-md",
                  span.status === "fail" &&
                    "bg-[var(--error)]/[0.08] border border-[var(--error)]/25",
                  span.live && "bg-[var(--terminal)]/[0.05]",
                )}
              >
                <div
                  className="flex items-center gap-2 min-w-0"
                  style={{ paddingLeft: `${span.depth * 12}px` }}
                >
                  {span.depth > 0 && (
                    <span
                      aria-hidden
                      className="text-[var(--text-faint)] shrink-0"
                    >
                      └
                    </span>
                  )}
                  <span
                    className={cn(
                      "truncate",
                      span.status === "fail"
                        ? "text-[var(--error)]"
                        : "text-[var(--text-primary)]",
                    )}
                  >
                    {span.name}
                  </span>
                  {span.live && (
                    <span
                      className={cn(
                        "shrink-0 inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]",
                        !reducedMotion &&
                          "animate-[glow-pulse_2.4s_ease-in-out_infinite]",
                      )}
                      aria-hidden
                    />
                  )}
                  {span.status === "fail" && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--error)] border border-[var(--error)]/40 px-1.5 py-0.5 rounded">
                      fail
                    </span>
                  )}
                </div>
                <span className="text-right text-[var(--text-muted)] truncate hidden sm:block">
                  {span.model}
                </span>
                <span className="text-right tabular-nums text-[var(--text-secondary)]">
                  {span.latency}
                </span>
                <span className="text-right tabular-nums text-[var(--text-secondary)]">
                  {span.cost}
                </span>
              </div>
              {span.status === "fail" && span.failDetail && (
                <p
                  className="text-[11px] text-[var(--text-muted)] px-2 pb-1"
                  style={{ paddingLeft: `${20 + span.depth * 14}px` }}
                >
                  {span.failDetail}
                </p>
              )}
            </div>
          ))}

          <div
            className="mt-1.5 pt-2.5 border-t border-[var(--border-subtle)] flex items-center gap-2.5 px-2"
            style={
              !reducedMotion && motionReady
                ? {
                    animation: `fade-slide-up 280ms var(--ease-out, cubic-bezier(0.33, 1, 0.68, 1)) both`,
                    animationDelay: `${TRACE_MOCK_SPANS.length * 70}ms`,
                  }
                : undefined
            }
          >
            <GitPullRequest
              className="w-3.5 h-3.5 text-[var(--accent)] shrink-0"
              aria-hidden
            />
            <span className="text-[var(--text-primary)] text-[12px] min-w-0 truncate">
              Improve:{" "}
              <span className="text-[var(--text-secondary)]">
                patch draft ready
              </span>
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-[var(--accent)]">
              view →
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
