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

type Variant = "bleed" | "inset";

/**
 * Stylized Traces explorer.
 * - ``bleed``: full-bleed hero plane — edge to edge product chrome
 * - ``inset``: bordered panel for secondary placements
 */
export function TracesExplorerMock({
  variant = "bleed",
}: {
  variant?: Variant;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [motionReady, setMotionReady] = useState(false);
  const bleed = variant === "bleed";

  useEffect(() => {
    if (reducedMotion) {
      setMotionReady(false);
      return;
    }
    const handle = requestAnimationFrame(() => setMotionReady(true));
    return () => cancelAnimationFrame(handle);
  }, [reducedMotion]);

  return (
    <div
      className={cn(
        bleed
          ? "absolute inset-0 overflow-hidden"
          : "order-2 w-full min-w-0 lg:col-span-7",
      )}
    >
      <div
        className={cn(
          "flex h-full flex-col overflow-hidden bg-[var(--bg-base)]",
          bleed
            ? // Full-bleed: stretch past the right edge; left is covered by hero scrim
              "absolute inset-y-0 left-[4%] right-0 w-auto min-w-[640px] border-l border-[var(--border-subtle)] bg-[var(--bg-base)] sm:left-[14%] md:left-[30%] lg:left-[36%]"
            : "rounded-lg border border-[var(--border-default)] shadow-[var(--shadow-sm,0_1px_0_rgba(255,255,255,0.03)_inset)]",
        )}
        role="img"
        aria-label="Traces explorer preview: span tree with model, latency, cost, a failed eval, and an Improve patch draft"
      >
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
            bleed ? "px-4 py-2.5 sm:px-5 sm:py-3" : "px-3 py-2 sm:px-4",
          )}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)] sm:text-[11px]">
            Traces
          </span>
          <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
            trace_8a3f…d1b
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--terminal)]">
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              {!reducedMotion && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--terminal)] opacity-70" />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
            </span>
            live
          </span>
        </div>

        <div
          className={cn(
            "grid shrink-0 grid-cols-[minmax(0,1fr)_4.25rem_4rem] gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/60 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_4.5rem] sm:gap-2",
            bleed ? "px-4 py-2 sm:px-5" : "px-3 py-1.5 sm:px-4",
          )}
        >
          <span>Span</span>
          <span className="hidden text-right sm:block">Model</span>
          <span className="text-right">Latency</span>
          <span className="text-right">Cost</span>
        </div>

        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-0.5 font-mono",
            bleed
              ? "p-3 text-[12px] sm:p-4 sm:text-[13px] md:text-[14px]"
              : "min-h-[240px] p-2 text-[12px] sm:min-h-[260px] sm:p-3 sm:text-[13px]",
          )}
        >
          {TRACE_MOCK_SPANS.map((span, index) => (
            <div
              key={span.id}
              className="flex flex-col gap-0.5"
              style={
                !reducedMotion && motionReady
                  ? {
                      animation: `fade-slide-up 320ms var(--ease-out, cubic-bezier(0.33, 1, 0.68, 1)) both`,
                      animationDelay: `${80 + index * 90}ms`,
                    }
                  : undefined
              }
            >
              <div
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_4.25rem_4rem] items-center gap-1.5 rounded-md px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_4.5rem] sm:gap-2 sm:py-2",
                  span.status === "fail" &&
                    "border border-[var(--error)]/25 bg-[var(--error)]/[0.08]",
                  span.live && "bg-[var(--terminal)]/[0.05]",
                )}
              >
                <div
                  className="flex min-w-0 items-center gap-2"
                  style={{ paddingLeft: `${span.depth * 12}px` }}
                >
                  {span.depth > 0 && (
                    <span
                      aria-hidden
                      className="shrink-0 text-[var(--text-faint)]"
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
                        "inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--terminal)]",
                        !reducedMotion &&
                          "animate-[glow-pulse_2.4s_ease-in-out_infinite]",
                      )}
                      aria-hidden
                    />
                  )}
                  {span.status === "fail" && (
                    <span className="shrink-0 rounded border border-[var(--error)]/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--error)]">
                      fail
                    </span>
                  )}
                </div>
                <span className="hidden truncate text-right text-[var(--text-muted)] sm:block">
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
                  className="px-2 pb-1 text-[11px] text-[var(--text-muted)]"
                  style={{ paddingLeft: `${20 + span.depth * 14}px` }}
                >
                  {span.failDetail}
                </p>
              )}
            </div>
          ))}

          <div
            className="mt-auto flex items-center gap-2.5 border-t border-[var(--border-subtle)] px-2 pt-3"
            style={
              !reducedMotion && motionReady
                ? {
                    animation: `fade-slide-up 320ms var(--ease-out, cubic-bezier(0.33, 1, 0.68, 1)) both`,
                    animationDelay: `${80 + TRACE_MOCK_SPANS.length * 90}ms`,
                  }
                : undefined
            }
          >
            <GitPullRequest
              className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
              aria-hidden
            />
            <span className="min-w-0 truncate text-[12px] text-[var(--text-primary)]">
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
