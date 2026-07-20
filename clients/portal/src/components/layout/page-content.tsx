"use client";

/**
 * PageContent — canonical inner wrapper for every (portal) page.
 *
 * Replaces the 31 hand-rolled `<div className="p-4 sm:p-6 lg:p-8 …">`
 * wrappers that have drifted across the surface (mix of max-w-6xl,
 * max-w-7xl, max-w-[1600px], p-4 alone, space-y-4/5/6, and
 * sometimes a duplicate `page-enter` class on top of the layout's
 * own). Every portal page should render its body inside this so:
 *
 *   • padding, max-width, and vertical rhythm are uniform
 *   • `page-enter` lives in exactly ONE place (here, not in the
 *     layout AND the page — that double-applied the fade animation)
 *   • when we want to change the default rhythm next month, we
 *     change one file instead of grepping through 31
 *
 * The `size` axis is intentional: most pages want max-w-6xl (1152px)
 * for reading copy + tables, but content-heavy surfaces (traces,
 * observability) want max-w-7xl (1280px) so a 12-column trace table
 * fits without horizontal scroll. Future variants: "narrow" (max-w-3xl,
 * for sign-up flows), "full" (no max, for editor surfaces).
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";

export type PageContentSize = "default" | "wide" | "narrow" | "full";

export interface PageContentProps {
  children: React.ReactNode;
  /** Page-wide wrapper variant. Default is the canonical `max-w-6xl`. */
  size?: PageContentSize;
  /** Tailwind classes to merge (e.g. `bg-[var(--bg-base)]` on a flat page). */
  className?: string;
  /**
   * When true (or under EmbeddedSurface), skip outer padding/max-width
   * so shell tab parents do not double-wrap layout chrome.
   */
  embedded?: boolean;
}

const SIZE: Record<PageContentSize, string> = {
  // Reading-first: light + tables fit comfortably without overflow.
  default: "max-w-6xl",
  // Wide table: 12+ column traces, cohort grids, settings layouts.
  wide: "max-w-7xl",
  // Narrow form: uses `max-w-3xl` (768px) so a focused wizard doesn't
  // stretch on a 4K screen.
  narrow: "max-w-3xl",
  // No max — full-bleed surfaces (builder canvas, replay timeline).
  full: "max-w-none",
};

export function PageContent({
  children,
  size = "default",
  className,
  embedded = false,
}: PageContentProps) {
  const inEmbeddedSurface = useEmbeddedSurface();
  const isEmbedded = embedded || inEmbeddedSurface;

  if (isEmbedded) {
    return (
      <div className={cn("w-full space-y-5", className)}>
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn(
        // Single source of truth for padding + rhythm.
        // Slightly more horizontal air on lg+; vertical space-y is
        // shared with embedded mode so hubs feel even.
        // `page-enter` lives on (portal)/layout.tsx so it fires once
        // for the route change, not twice (parent + this wrapper).
        "w-full mx-auto",
        "px-4 py-4 sm:px-6 sm:py-5 lg:px-10 lg:py-6",
        "space-y-5",
        SIZE[size],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Inline loading row inside canonical page padding (early-return branches). */
export function PageLoading({
  size = "default",
  message = "Loading…",
  className,
}: {
  size?: PageContentSize;
  message?: string;
  className?: string;
}) {
  return (
    <PageContent size={size} className={cn("flex items-center gap-2 text-sm text-[var(--text-muted)]", className)}>
      <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden />
      {message}
    </PageContent>
  );
}

/** Full-page skeleton inside canonical padding (route loading.tsx). */
export function PageLoadingSkeleton({
  size = "default",
  variant = "default",
  lines = 4,
}: {
  size?: PageContentSize;
  variant?: "default" | "stats" | "table" | "detail";
  lines?: number;
}) {
  return <LoadingSkeleton size={size} variant={variant} lines={lines} />;
}
