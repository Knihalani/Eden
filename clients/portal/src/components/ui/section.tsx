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
        "rounded-xl bg-[var(--bg-secondary)] overflow-hidden",
        className
      )}
      {...props}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
          <div className="min-w-0">
            {title && (
              <h3 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
                {title}
              </h3>
            )}
            {description && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cn(hasHeader ? "px-4 pb-4" : "", contentClassName)}>{children}</div>
    </section>
  );
}
