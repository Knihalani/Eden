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
  /**
   * Hide on viewports below `lg` when the AI FAB + MobileBottomNav share
   * the bottom edge (Wave 5 / Home Shell W9). Desktop still shows when
   * selection &gt; 0. Never stacks with mobile thumb chrome.
   */
  hideOnMobile?: boolean;
}

export function BulkActionBar({
  count,
  actions,
  onClear,
  hideOnMobile = true,
}: BulkActionBarProps) {
  if (count <= 0) return null;
  return (
    <div
      className={cn(
        "sticky z-[var(--z-bulk-bar)] mx-auto max-w-3xl",
        /* Sit above MobileBottomNav on small screens; desktop has no bottom nav. */
        "bottom-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom)+1rem)] lg:bottom-4",
        "flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl",
        "bg-[var(--bg-primary)] border border-[var(--border-default)] shadow-lg",
        hideOnMobile && "hidden lg:flex",
      )}
      role="toolbar"
      aria-label="Bulk actions"
      data-hide-on-mobile={hideOnMobile ? "true" : "false"}
      data-bottom-layer="bulk-bar"
      data-wave9-bulk="hide-on-mobile"
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
