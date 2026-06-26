"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  /** Optional "Welcome back, X" badge shown above the title. */
  greeting?: string;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  icon: Icon,
  className,
  greeting,
}: PageHeaderProps) {
  return (
    // `flex-col sm:flex-row sm:items-start` so the actions slot
    // wraps below the title on narrow viewports instead of
    // overflowing horizontally. June 2026 layout-pass fix.
    <div className={cn("flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8", className)}>
      <div className="min-w-0 flex items-start gap-3">
        {Icon && (
          <div className="w-10 h-10 rounded-xl bg-[var(--accent-faint)] border border-[var(--accent)]/20 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-[var(--accent)]" />
          </div>
        )}
        <div className="min-w-0">
          {greeting && (
            <p className="text-xs font-mono text-[var(--text-muted)] mb-1.5">{greeting}</p>
          )}
          {eyebrow && (
            <p className="text-xs font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-1.5">
              {eyebrow}
            </p>
          )}
          {/* Title scales from `text-2xl` (mobile) to `text-3xl`
              (lg+) so a long page name doesn't dominate small
              screens. June 2026 layout-pass fix. */}
          <h1 className="text-2xl lg:text-3xl font-bold text-[var(--text-primary)] tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm text-[var(--text-muted)] mt-1">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
