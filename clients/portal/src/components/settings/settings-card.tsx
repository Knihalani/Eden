import { cn } from "@/lib/utils";

interface SettingsCardProps {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  contentClassName?: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * SettingsCard — the canonical card shell for every settings tab.
 * Replaces the "rounded-lg border border-[var(--border-default)]
 * bg-[var(--bg-primary)] p-6" pattern that was copy-pasted across
 * all 15 settings tabs.
 *
 * Phase 7 of the June 2026 UI overhaul.
 */
export function SettingsCard({
  title,
  description,
  actions,
  contentClassName,
  className,
  children,
}: SettingsCardProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-sm",
        className
      )}
    >
      {(title || description || actions) && (
        <header className="flex items-start justify-between gap-3 p-5 border-b border-[var(--border-default)]">
          <div>
            {title && (
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
            )}
            {description && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cn("p-5", contentClassName)}>{children}</div>
    </section>
  );
}
