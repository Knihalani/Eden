"use client";

/**
 * PageContent — canonical inner wrapper for settings-style pages.
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LoadingSkeleton } from "@/components/ui/skeleton";

export type PageContentSize = "default" | "wide" | "narrow" | "full";

export interface PageContentProps {
  children: React.ReactNode;
  size?: PageContentSize;
  className?: string;
  /** Skip outer padding/max-width when parent already frames content. */
  embedded?: boolean;
}

const SIZE: Record<PageContentSize, string> = {
  default: "max-w-6xl",
  wide: "max-w-7xl",
  narrow: "max-w-3xl",
  full: "max-w-none",
};

export function PageContent({
  children,
  size = "default",
  className,
  embedded = false,
}: PageContentProps) {
  if (embedded) {
    return (
      <div className={cn("w-full space-y-space-5", className)}>{children}</div>
    );
  }

  return (
    <div
      className={cn(
        "mx-auto w-full",
        "px-space-4 py-space-4 sm:px-space-5 sm:py-space-5 lg:px-space-7 lg:py-space-6",
        "space-y-space-5",
        SIZE[size],
        className,
      )}
    >
      {children}
    </div>
  );
}

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
    <PageContent
      size={size}
      className={cn(
        "flex items-center gap-2 text-sm text-[var(--text-muted)]",
        className,
      )}
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      {message}
    </PageContent>
  );
}

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
