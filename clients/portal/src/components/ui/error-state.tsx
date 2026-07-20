"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ERROR_STATE_ATTR } from "@/lib/overlay-defer";
import { Button } from "@/components/ui/button";

interface ErrorStateProps {
  title?: string;
  message?: string;
  error?: Error | string | null;
  /** Action button (e.g. "Try again"). Takes precedence over `onRetry`. */
  action?: React.ReactNode;
  /**
   * When set (and `action` is omitted), renders a consistent ≥44px
   * "Try again" button — no dead-end error panels.
   */
  onRetry?: () => void;
  className?: string;
  size?: "sm" | "md" | "lg";
}

/**
 * ErrorState — a consistent "something went wrong" panel with a
 * "Try again" slot. Replaces the ad-hoc error rendering that was
 * inlined in analytics, llmops, incidents, and other pages.
 *
 * Phase 7 of the June 2026 UI overhaul.
 *
 * Marks itself with ``data-eden-error-state`` so cookie / tour
 * overlays can defer instead of stacking on a failure surface.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  error,
  action,
  onRetry,
  className,
  size = "md",
}: ErrorStateProps) {
  const sizes = {
    sm: "p-space-4",
    md: "p-space-5",
    lg: "p-space-7",
  } as const;
  const iconSizes = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-12 h-12",
  } as const;
  const titleSizes = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-lg",
  } as const;

  const resolvedAction =
    action ??
    (onRetry ? (
      <Button type="button" onClick={onRetry} variant="outline" className="min-h-11">
        <RefreshCw className="h-4 w-4" />
        Try again
      </Button>
    ) : null);

  return (
    <div
      role="alert"
      {...{ [ERROR_STATE_ATTR]: "" }}
      className={cn(
        "bg-transparent border border-[var(--border-default)] rounded-xl text-center",
        sizes[size],
        className
      )}
    >
      <AlertTriangle className={cn("mx-auto mb-space-3 text-[var(--error)]", iconSizes[size])} />
      <h3 className={cn("font-semibold text-[var(--error)]", titleSizes[size])}>
        {title}
      </h3>
      <p className="mt-space-1 text-sm text-[var(--text-secondary)] max-w-md mx-auto">
        {message ?? (error instanceof Error ? error.message : String(error ?? ""))}
      </p>
      {resolvedAction && <div className="mt-space-4">{resolvedAction}</div>}
    </div>
  );
}
