"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  size?: "sm" | "md" | "lg";
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
  size = "md",
  className,
}: EmptyStateProps) {
  const s = SIZE_STYLES[size];
  return (
    <div className={cn("text-center", s.wrap, className)}>
      <div
        className={cn(
          "mx-auto rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)]",
          s.iconWrap,
        )}
      >
        <Icon className={cn(s.icon, "stroke-1")} />
      </div>
      <p className={cn("font-medium text-[var(--text-secondary)]", s.title)}>
        {title}
      </p>
      {description && (
        <p
          className={cn(
            "text-[var(--text-muted)] mt-1 max-w-xs mx-auto leading-relaxed",
            s.description,
          )}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
