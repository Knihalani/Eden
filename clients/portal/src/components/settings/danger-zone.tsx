"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface DangerZoneProps {
  title?: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * DangerZone — a card that visually separates destructive actions
 * from the rest of a settings tab. Red border + warning icon +
 * monospace title signal "this will hurt" to the user.
 *
 * Phase 7 of the June 2026 UI overhaul.
 */
export function DangerZone({
  title = "Danger zone",
  description,
  className,
  children,
}: DangerZoneProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-[var(--error)]/30 bg-[var(--error-dim)]/40",
        className
      )}
    >
      <header className="flex items-start gap-3 p-5 border-b border-[var(--error)]/20">
        <AlertTriangle className="w-5 h-5 text-[var(--error)] shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-mono font-semibold text-[var(--error)] uppercase tracking-wide">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{description}</p>
          )}
        </div>
      </header>
      <div className="p-5 space-y-3">{children}</div>
    </section>
  );
}
