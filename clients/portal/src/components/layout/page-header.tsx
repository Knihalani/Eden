"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
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
            <p className="text-xs text-[var(--text-secondary)] mb-1.5 leading-relaxed">
              {greeting}
            </p>
          )}
          {eyebrow && (
            <p className="text-xs font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-1.5">
              {eyebrow}
            </p>
          )}
          {/* Title scales from `text-2xl` (mobile) to `text-3xl`
              (lg+) so a long page name doesn't dominate small
              screens. June 2026 layout-pass fix. */}
          <div className="flex items-center gap-2">
            <h1 className="text-2xl lg:text-3xl font-bold text-[var(--text-primary)] tracking-tight">
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
                    <Info className="w-4 h-4" />
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
            <p className="text-sm text-[var(--text-muted)] mt-1">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
