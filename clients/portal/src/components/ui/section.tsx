import * as React from "react";
import { cn } from "@/lib/utils";

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  contentClassName?: string;
}

/**
 * Section — a labeled content block. Used as the structural shell for
 * ChartCard, MetricPanel, and other top-level page panels.
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
        "rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-sm",
        className
      )}
      {...props}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            {title && (
              <h3 className="text-base font-semibold text-[var(--text-primary)] tracking-tight">
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
      <div className={cn(hasHeader ? "px-5 pb-5" : "", contentClassName)}>{children}</div>
    </section>
  );
}
