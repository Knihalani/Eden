"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  message?: string;
  error?: Error | string | null;
  /** Action button (e.g. "Try again"). */
  action?: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}

/**
 * ErrorState — a consistent "something went wrong" panel with a
 * "Try again" slot. Replaces the ad-hoc error rendering that was
 * inlined in analytics, llmops, incidents, and other pages.
 *
 * Phase 7 of the June 2026 UI overhaul.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  error,
  action,
  className,
  size = "md",
}: ErrorStateProps) {
  const sizes = {
    sm: "p-4",
    md: "p-6",
    lg: "p-10",
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
  return (
    <div
      role="alert"
      className={cn(
        "bg-[var(--bg-primary)] border border-[var(--error)]/30 rounded-xl text-center",
        sizes[size],
        className
      )}
    >
      <AlertTriangle className={cn("mx-auto mb-3 text-[var(--error)]", iconSizes[size])} />
      <h3 className={cn("font-semibold text-[var(--text-primary)]", titleSizes[size])}>
        {title}
      </h3>
      <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-md mx-auto">
        {message ?? (error instanceof Error ? error.message : String(error ?? ""))}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
