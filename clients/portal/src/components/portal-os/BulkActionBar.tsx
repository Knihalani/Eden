"use client";

import { cn } from "@/lib/utils";

export interface BulkActionBarProps {
  count: number;
  actions: Array<{
    label: string;
    onClick: () => void;
    variant?: "default" | "destructive";
  }>;
  onClear: () => void;
}

export function BulkActionBar({ count, actions, onClear }: BulkActionBarProps) {
  if (count <= 0) return null;
  return (
    <div
      className={cn(
        "sticky bottom-4 z-20 mx-auto max-w-3xl",
        "mb-[env(safe-area-inset-bottom)] lg:mb-0",
        "flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl",
        "bg-[var(--bg-primary)] border border-[var(--border-default)] shadow-lg",
      )}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="text-sm text-[var(--text-secondary)]">
        {count} selected
      </span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={a.onClick}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg font-medium",
            a.variant === "destructive"
              ? "bg-[var(--error-dim)] text-[var(--error)]"
              : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--accent-faint)]",
          )}
        >
          {a.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        Clear selection
      </button>
    </div>
  );
}

export {
  DetailPanelShell,
  type DetailPanelShellProps,
  type DetailPanelTab,
} from "./DetailPanelShell";
