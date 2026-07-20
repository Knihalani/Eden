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
 * DangerZone — canonical shell for destructive settings actions.
 * Red border + warning icon + monospace title. Use on every tab
 * that exposes irreversible or high-risk controls.
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
        className,
      )}
      data-settings-danger-zone=""
    >
      <header className="flex items-start gap-space-3 p-space-5 border-b border-[var(--error)]/20">
        <AlertTriangle className="w-5 h-5 text-[var(--error)] shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-mono font-semibold text-[var(--error)] uppercase tracking-wide">
            {title}
          </h2>
          {description ? (
            <p className="mt-space-1 text-xs text-[var(--text-secondary)]">{description}</p>
          ) : null}
        </div>
      </header>
      <div className="p-space-5 space-y-space-3">{children}</div>
    </section>
  );
}
