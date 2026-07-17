"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TurnCard } from "./TurnCard";
import { cn } from "@/lib/utils";

export type SessionTurn = {
  trace_id: string;
  summary?: string;
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
}

/** N12 horizontal multi-turn timeline with keyboard ←/→ navigation. */
export function SessionTurnTimeline({
  turns,
  selectedTraceId,
  onSelectTurn,
  className,
}: SessionTurnTimelineProps) {
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

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Timeline</h2>
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
      </div>
      <div
        ref={scrollerRef}
        className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory"
        role="list"
        aria-label="Session turns"
      >
        {turns.map((turn, i) => (
          <div key={turn.trace_id} role="listitem" className="snap-center">
            <TurnCard
              index={i}
              total={turns.length}
              traceId={turn.trace_id}
              summary={turn.summary}
              durationMs={turn.duration_ms}
              costCents={turn.cost_cents}
              outcome={turn.outcome}
              hadStumble={turn.had_stumble}
              selected={turn.trace_id === (selectedTraceId ?? turns[focusIndex]?.trace_id)}
              onSelect={() => {
                setFocusIndex(i);
                onSelectTurn(turn.trace_id);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
