"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Page identity — title + optional subtitle/actions.
 * Location lives in AppShell breadcrumbs (DESIGN-SYSTEM-V2 §8.11).
 */
export interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  /** @deprecated unused — never rendered */
  eyebrow?: string;
  actions?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  greeting?: string;
  /** @deprecated unused — never rendered */
  description?: string;
  /** Hide title chrome (actions only). */
  embedded?: boolean;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow: _eyebrow,
  actions,
  icon: Icon,
  className,
  greeting,
  description: _description,
  embedded = false,
}: PageHeaderProps) {
  if (embedded) {
    if (!actions) return null;
    return (
      <div
        className={cn(
          "mb-space-3 flex flex-wrap items-center justify-end gap-space-2",
          className,
        )}
      >
        {actions}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mb-space-4 flex flex-col justify-between gap-space-3 sm:flex-row sm:items-start",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-space-3">
        {Icon ? (
          <Icon
            className="mt-space-1 h-4 w-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden
          />
        ) : null}
        <div className="min-w-0">
          {greeting ? (
            <p className="mb-space-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              {greeting}
            </p>
          ) : null}
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-[var(--text-primary)] lg:text-2xl">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-space-1 text-sm text-[var(--text-muted)]">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-space-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
