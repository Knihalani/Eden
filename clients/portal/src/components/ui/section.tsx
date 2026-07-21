import * as React from "react";
import { cn } from "@/lib/utils";

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  contentClassName?: string;
}

/**
 * Section — labeled content block without a full card border.
 * Uses Panel-like flat grouping so ChartCard / MetricPanel parents
 * do not stack border-on-border with surrounding Cards. Prefer
 * Card only when the block is interactive or a true container.
 */
export function Section({
  title,
  description,
  actions,
  className,
  contentClassName,
  children,
  ...props
}: SectionProps) {
  const hasHeader = title || description || actions;
  return (
    <section
      className={cn(
        // Quiet chart host — tonal lift only, no border stack (Wave 6.8).
        "overflow-hidden rounded-xl bg-[var(--bg-secondary)]",
        className
      )}
      data-chart-quiet="true"
      {...props}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 px-3 pb-1.5 pt-3">
          <div className="min-w-0">
            {title && (
              <h3 className="text-sm font-medium tracking-tight text-[var(--text-primary)]">
                {title}
              </h3>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn(hasHeader ? "px-3 pb-3" : "", contentClassName)}>{children}</div>
    </section>
  );
}
