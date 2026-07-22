"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useDensity } from "@/components/shell/density-provider";

export interface QueryFilterBarProps {
  /** Hub lens control (traces | spans | sessions). */
  view?: ReactNode;
  /** Structured filter controls (outcome, agent, …). */
  filter?: ReactNode;
  /** Display toggles (columns, live, density). */
  display?: ReactNode;
  /** Search input. */
  search?: ReactNode;
  /** Overflow / More menu. */
  overflow?: ReactNode;
  /** Relative / absolute time window. */
  time?: ReactNode;
  sticky?: boolean;
  className?: string;
}

/**
 * Observe toolbar grammar: View · Filter · Display · Search · Overflow · time.
 * Slot-based so hubs compose ≤5 primary controls without a third chrome band.
 */
export function QueryFilterBar({
  view,
  filter,
  display,
  search,
  overflow,
  time,
  sticky = false,
  className,
}: QueryFilterBarProps) {
  const { density } = useDensity();

  return (
    <div
      className={cn(
        sticky && "sticky top-11 z-10",
        density === "compact" ? "space-y-space-1" : "space-y-space-2",
        className,
      )}
      data-density={density}
      data-testid="query-filter-bar"
    >
      <div
        className={cn(
          "flex flex-wrap items-center border border-[var(--border-subtle)] bg-[var(--bg-primary)] rounded-lg",
          density === "compact"
            ? "gap-space-2 px-space-2 py-space-1"
            : "gap-space-3 px-space-3 py-space-2",
        )}
      >
        {view ? (
          <div className="flex min-w-0 items-center gap-space-2" data-slot="view">
            {view}
          </div>
        ) : null}
        {filter ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-space-2"
            data-slot="filter"
          >
            {filter}
          </div>
        ) : null}
        {display ? (
          <div
            className="flex min-w-0 items-center gap-space-2"
            data-slot="display"
          >
            {display}
          </div>
        ) : null}
        {search ? (
          <div
            className="flex min-w-[12rem] flex-1 items-center"
            data-slot="search"
          >
            {search}
          </div>
        ) : null}
        {time ? (
          <div
            className="flex shrink-0 items-center gap-space-2"
            data-slot="time"
          >
            {time}
          </div>
        ) : null}
        {overflow ? (
          <div
            className="ml-auto flex shrink-0 items-center gap-space-2"
            data-slot="overflow"
          >
            {overflow}
          </div>
        ) : null}
      </div>
    </div>
  );
}
