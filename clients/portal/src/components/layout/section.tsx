"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SectionProps {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

export function Section({
  title,
  description,
  actions,
  className,
  contentClassName,
  children,
}: SectionProps) {
  return (
    <div
      className={cn(
        "bg-[var(--bg-primary)] rounded-xl border border-[var(--border-subtle)] p-5",
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                {title}
              </h2>
            )}
            {description && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(contentClassName)}>{children}</div>
    </div>
  );
}
