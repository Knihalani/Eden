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
   * `panel` — wrap the empty state in a bordered Card surface (default).
   * `plain` — flat, no surface, just centred content. Use when the
   * parent already provides the surface and the empty state shouldn't
   * double-frame it.
   * `terminal` — replace the icon with the `terminal` slot. Use for
   * data-product empty states where a "this is what you'd see" preview
   * sells the value better than an icon.
   */
  variant?: "panel" | "plain" | "terminal";
  className?: string;
}

const SIZE_STYLES: Record<NonNullable<EmptyStateProps["size"]>, {
  wrap: string;
  iconWrap: string;
  icon: string;
  title: string;
  description: string;
}> = {
  sm: {
    wrap: "py-4",
    iconWrap: "w-8 h-8 mb-2",
    icon: "w-4 h-4",
    title: "text-xs",
    description: "text-xs",
  },
  md: {
    wrap: "py-8",
    iconWrap: "w-10 h-10 mb-3",
    icon: "w-5 h-5",
    title: "text-sm",
    description: "text-sm",
  },
  lg: {
    wrap: "py-12",
    iconWrap: "w-12 h-12 mb-4",
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
  variant = "panel",
  className,
}: EmptyStateProps) {
  const s = SIZE_STYLES[size];
  const inner = (
    <>
      {variant === "terminal" && terminal ? (
        <div className="mb-5 mx-auto max-w-md">{terminal}</div>
      ) : (
        Icon && (
          <div
            className={cn(
              "mx-auto rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)]",
              s.iconWrap,
            )}
          >
            <Icon className={cn(s.icon, "stroke-1")} aria-hidden />
          </div>
        )
      )}
      <p className={cn("font-medium text-[var(--text-secondary)]", s.title)}>
        {title}
      </p>
      {description && (
        <p
          className={cn(
            "text-[var(--text-muted)] mt-1 max-w-md mx-auto leading-relaxed",
            s.description,
          )}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </>
  );

  if (variant === "panel") {
    return (
      <div
        className={cn(
          "rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] text-center p-6",
          s.wrap,
          className,
        )}
      >
        {inner}
      </div>
    );
  }

  return (
    <div className={cn("text-center", s.wrap, className)}>
      {inner}
    </div>
  );
}
