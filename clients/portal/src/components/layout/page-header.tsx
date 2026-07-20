"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";

export interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
  /**
   * Optional decorative icon. Prefer omitting — AppShell breadcrumbs
   * already locate the page. When passed, renders as a quiet glyph
   * (no accent chip) so dual chrome stays light.
   */
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  /** Optional "Welcome back, X" badge shown above the title. */
  greeting?: string;
  /** One-line "what is this page for" hint shown in a tooltip next
   *  to the title. Critical for navigation clarity — pages like
   *  "Traces", "Replay", "Inspector", and "Time-Travel" have icons
   *  and labels that look similar. A hover hint tells the user
   *  which is which without making them navigate in. */
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
  eyebrow,
  actions,
  icon: Icon,
  className,
  greeting,
  description,
  embedded = false,
}: PageHeaderProps) {
  const inEmbeddedSurface = useEmbeddedSurface();
  const hideChrome = embedded || inEmbeddedSurface;

  if (hideChrome) {
    if (!actions) return null;
    return (
      <div className={cn("mb-3 flex flex-wrap items-center justify-end gap-2", className)}>
        {actions}
      </div>
    );
  }

  return (
    // Compact title row — location lives in AppShell breadcrumbs;
    // this is page identity + actions only. Actions wrap below on
    // narrow viewports instead of overflowing horizontally.
    <div className={cn("flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4", className)}>
      <div className="min-w-0 flex items-start gap-2.5">
        {Icon && (
          <Icon
            className="mt-0.5 w-4 h-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden
          />
        )}
        <div className="min-w-0">
          {greeting && (
            <p className="text-xs text-[var(--text-secondary)] mb-1 leading-relaxed">
              {greeting}
            </p>
          )}
          {eyebrow && (
            <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-1">
              {eyebrow}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <h1 className="text-xl lg:text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
              {title}
            </h1>
            {description && (
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`About ${title}`}
                    className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6} className="max-w-[280px]">
                  <div className="font-medium text-[var(--text-primary)]">About this page</div>
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug">
                    {description}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {subtitle && (
            <p className="text-sm text-[var(--text-muted)] mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
