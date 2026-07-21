"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";

/**
 * Wave 1.5 PageHeader grammar freeze.
 *
 * Canonical page identity = `title` (+ optional `actions`, optional
 * `subtitle` for a page-specific one-liner that is NOT a location cue).
 *
 * Location lives in AppShell breadcrumbs — do not pass category
 * eyebrows (`Observe`, `Settings`, `Eval`, etc.). Eyebrow / description
 * props are accepted for backward compat but intentionally not rendered.
 */
export interface PageHeaderProps {
  /** Canonical page identity. AppShell breadcrumbs own location. */
  title: string;
  /**
   * Optional page-specific supporting one-liner under the title.
   * Not a location cue (categories belong in breadcrumbs).
   */
  subtitle?: React.ReactNode;
  /**
   * @deprecated Wave 1.5 — unused. Location = AppShell breadcrumbs.
   * Do not pass category labels (`Observe`, `Settings`, `Eval`, …).
   * Kept so call sites do not break; never rendered.
   */
  eyebrow?: string;
  actions?: React.ReactNode;
  /**
   * Optional decorative icon. Prefer omitting — AppShell breadcrumbs
   * already locate the page. When passed, renders as a quiet glyph
   * (no accent chip) so dual chrome stays light.
   */
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  /** Optional "Welcome back, X" line above the title (Home only). */
  greeting?: string;
  /**
   * @deprecated Wave 1.5 — unused. Description / Info tooltip removed
   * from the title row (no eyebrow + hint + title triple). Kept for
   * call-site compat; never rendered.
   */
  description?: string;
  /**
   * When true (or under EmbeddedSurface), hide title chrome so shell
   * tab parents do not double-header. Actions still render.
   */
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
  const inEmbeddedSurface = useEmbeddedSurface();
  const hideChrome = embedded || inEmbeddedSurface;

  if (hideChrome) {
    if (!actions) return null;
    return (
      <div className={cn("mb-space-3 flex flex-wrap items-center justify-end gap-space-2", className)}>
        {actions}
      </div>
    );
  }

  return (
    // Compact title row — location lives in AppShell breadcrumbs;
    // this is page identity + actions only. Actions wrap below on
    // narrow viewports instead of overflowing horizontally.
    <div className={cn("flex flex-col sm:flex-row sm:items-start justify-between gap-space-3 mb-space-4", className)}>
      <div className="min-w-0 flex items-start gap-space-3">
        {Icon && (
          <Icon
            className="mt-space-1 w-4 h-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden
          />
        )}
        <div className="min-w-0">
          {greeting && (
            <p className="text-xs text-[var(--text-secondary)] mb-space-1 leading-relaxed">
              {greeting}
            </p>
          )}
          <h1 className="text-xl lg:text-2xl font-semibold text-[var(--text-primary)] tracking-tight leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm text-[var(--text-muted)] mt-space-1">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-space-2 shrink-0">{actions}</div>}
    </div>
  );
}
