"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TurnCard } from "./TurnCard";
import { cn } from "@/lib/utils";
import type { TracePreserveParams } from "@/lib/portal-cross-links";

export type SessionTurn = {
  trace_id: string;
  summary?: string;
  input_preview?: string | null;
  output_preview?: string | null;
  duration_ms?: number;
  cost_cents?: number | null;
  outcome?: string | null;
  had_stumble?: boolean;
};

export interface SessionTurnTimelineProps {
  turns: SessionTurn[];
  selectedTraceId?: string;
  onSelectTurn: (traceId: string) => void;
  className?: string;
  /** Horizontal rail (session page) or stacked cards (hub expand). */
  layout?: "rail" | "stack";
  openTraceView?: "traces" | "sessions";
  /** Preserve hub filters on Open-trace deep links. */
  preserve?: TracePreserveParams;
}

/** N12 multi-turn timeline with keyboard ←/→ navigation. */
export function SessionTurnTimeline({
  turns,
  selectedTraceId,
  onSelectTurn,
  className,
  layout = "rail",
  openTraceView = "traces",
  preserve,
}: SessionTurnTimelineProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  const selectedIndex = turns.findIndex(
    (t) => t.trace_id === (selectedTraceId ?? turns[focusIndex]?.trace_id),
  );

  useEffect(() => {
    if (selectedIndex >= 0) setFocusIndex(selectedIndex);
  }, [selectedIndex]);

  const scrollToIndex = useCallback((idx: number) => {
    const el = scrollerRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (turns.length === 0) return;
      const next = Math.max(0, Math.min(turns.length - 1, focusIndex + delta));
      setFocusIndex(next);
      onSelectTurn(turns[next].trace_id);
      scrollToIndex(next);
    },
    [focusIndex, turns, onSelectTurn, scrollToIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      // Scope to timeline — don't steal filter typing or transcript ←/→.
      if (!rootRef.current?.contains(target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  if (turns.length === 0) {
    return (
      <p className={cn("text-sm text-[var(--text-muted)]", className)}>
        No turns in this session.
      </p>
    );
  }

  const renderCard = (turn: SessionTurn, i: number) => (
    <TurnCard
      index={i}
      total={turns.length}
      traceId={turn.trace_id}
      summary={turn.summary}
      inputPreview={turn.input_preview}
      outputPreview={turn.output_preview}
      durationMs={turn.duration_ms}
      costCents={turn.cost_cents}
      outcome={turn.outcome}
      hadStumble={turn.had_stumble}
      selected={turn.trace_id === (selectedTraceId ?? turns[focusIndex]?.trace_id)}
      openTraceView={openTraceView}
      preserve={preserve}
      className={layout === "stack" ? "w-full" : undefined}
      onSelect={() => {
        setFocusIndex(i);
        onSelectTurn(turn.trace_id);
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      className={cn("space-y-2", className)}
      data-testid="session-turn-timeline"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {layout === "stack" ? "Turns" : "Timeline"}
        </h2>
        {layout === "rail" ? (
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Previous turn"
              disabled={focusIndex <= 0}
              onClick={() => move(-1)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Next turn"
              disabled={focusIndex >= turns.length - 1}
              onClick={() => move(1)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : null}
      </div>
      {layout === "stack" ? (
        <div
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
          role="list"
          aria-label="Session turns"
          data-testid="session-turn-cards"
        >
          {turns.map((turn, i) => (
            <div key={turn.trace_id} role="listitem">
              {renderCard(turn, i)}
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={scrollerRef}
          className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory"
          role="list"
          aria-label="Session turns"
          data-testid="session-turn-cards"
        >
          {turns.map((turn, i) => (
            <div key={turn.trace_id} role="listitem" className="snap-center">
              {renderCard(turn, i)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
