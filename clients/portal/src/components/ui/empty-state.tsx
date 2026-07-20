"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * Optional terminal-flavoured slot rendered above the title. Pass a
   * mock log line, a sparkline preview, or any "what data would look
   * like" element. Empty-state-as-terminal gives an ops product a
   * stronger brand moment than the generic "empty inbox" icon.
   */
  terminal?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /**
   * `plain` — flat, no surface, just centred content (default). Quieter
   * chrome; use when the parent already provides the surface.
   * `panel` — wrap in a bordered Card surface when a standalone frame
   * is needed.
   * `terminal` — replace the icon with the `terminal` slot. Use for
   * data-product empty states where a "this is what you'd see" preview
   * sells the value better than an icon.
   */
  variant?: "panel" | "plain" | "terminal";
  className?: string;
  /** Optional id for the title heading (aria-labelledby). */
  titleId?: string;
}

const SIZE_STYLES: Record<NonNullable<EmptyStateProps["size"]>, {
  wrap: string;
  iconWrap: string;
  icon: string;
  title: string;
  description: string;
}> = {
  sm: {
    wrap: "py-space-4",
    iconWrap: "w-8 h-8 mb-space-2",
    icon: "w-4 h-4",
    title: "text-xs",
    description: "text-xs",
  },
  md: {
    wrap: "py-space-6",
    iconWrap: "w-10 h-10 mb-space-3",
    icon: "w-5 h-5",
    title: "text-sm",
    description: "text-sm",
  },
  lg: {
    wrap: "py-space-8",
    iconWrap: "w-12 h-12 mb-space-4",
    icon: "w-6 h-6",
    title: "text-base",
    description: "text-sm",
  },
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  terminal,
  size = "md",
  variant = "plain",
  className,
  titleId,
}: EmptyStateProps) {
  const s = SIZE_STYLES[size];
  const autoId = React.useId();
  const headingId = titleId ?? autoId;
  const inner = (
    <>
      {variant === "terminal" && terminal ? (
        <div className="mb-space-5 mx-auto max-w-md" aria-hidden={true}>
          {terminal}
        </div>
      ) : (
        Icon && (
          <div
            className={cn(
              "mx-auto rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)]",
              s.iconWrap,
            )}
            aria-hidden="true"
          >
            <Icon className={cn(s.icon, "stroke-1")} aria-hidden />
          </div>
        )
      )}
      <p
        id={headingId}
        className={cn("font-medium text-[var(--text-primary)]", s.title)}
      >
        {title}
      </p>
      {description && (
        <p
          className={cn(
            "text-[var(--text-muted)] mt-space-1 max-w-md mx-auto leading-relaxed",
            s.description,
          )}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-space-4">{action}</div>}
    </>
  );

  if (variant === "panel") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-labelledby={headingId}
        className={cn(
          "rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-center p-space-5",
          s.wrap,
          className,
        )}
      >
        {inner}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby={headingId}
      className={cn("text-center", s.wrap, className)}
    >
      {inner}
    </div>
  );
}
