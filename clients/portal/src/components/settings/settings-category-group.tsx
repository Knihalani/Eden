"use client";

/**
 * SettingsCategoryGroup — collapsible group header for the
 * Settings tab rail (Org · Members · Security · Compliance ·
 * Billing · Advanced). Collapse state persists in localStorage.
 * Advanced defaults collapsed; search forces groups open.
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "eden:settings:cat-collapsed";

/** First-visit defaults — Advanced starts collapsed to shorten the rail. */
const DEFAULT_COLLAPSED: Record<string, boolean> = {
  Advanced: true,
};

function readCollapsed(): Record<string, boolean> {
  if (typeof window === "undefined") return { ...DEFAULT_COLLAPSED };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COLLAPSED };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_COLLAPSED };
    return { ...DEFAULT_COLLAPSED, ...(parsed as Record<string, boolean>) };
  } catch {
    return { ...DEFAULT_COLLAPSED };
  }
}

function writeCollapsed(next: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // non-fatal
  }
}

interface SettingsCategoryGroupProps {
  category: string;
  /** Visible tab count within this group. */
  count?: number;
  /** When searching, force the group open so matches stay visible. */
  forceExpanded?: boolean;
  children: React.ReactNode;
}

export function SettingsCategoryGroup({
  category,
  count,
  forceExpanded = false,
  children,
}: SettingsCategoryGroupProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(DEFAULT_COLLAPSED);

  // Hydrate after mount so SSR matches the first client paint defaults.
  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const isCollapsed = !forceExpanded && collapsed[category] === true;

  const toggle = () => {
    if (forceExpanded) return;
    const next = { ...collapsed, [category]: !isCollapsed };
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <div className="space-y-space-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!isCollapsed}
        aria-controls={`settings-cat-${category}`}
        disabled={forceExpanded}
        className={cn(
          "w-full flex items-center justify-between gap-space-2 px-space-2 py-space-1 text-2xs font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)] rounded transition-colors",
          forceExpanded
            ? "cursor-default opacity-90"
            : "hover:text-[var(--text-secondary)]",
        )}
      >
        <span className="flex items-center gap-space-2 min-w-0">
          <ChevronDown
            className={cn(
              "w-3 h-3 transition-transform shrink-0",
              isCollapsed && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate">{category}</span>
          {typeof count === "number" ? (
            <span className="text-[var(--text-faint)]">({count})</span>
          ) : null}
        </span>
      </button>
      {!isCollapsed ? (
        <div id={`settings-cat-${category}`} className="space-y-space-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}
