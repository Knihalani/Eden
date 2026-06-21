"use client";

/**
 * SettingsCategoryGroup — collapsible group header for the
 * Settings tab rail.
 *
 * State is persisted to localStorage so the user's collapse
 * preference survives reloads. The 6 categories ("Org",
 * "Members", "Security", "Compliance", "Billing", "Advanced")
 * match the taxonomy declared in settings/page.tsx.
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "eden:settings:cat-collapsed";

function readCollapsed(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
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
  /** Visible tab count within this group (so the header can show
   *  "(3)" if the user wants). Optional. */
  count?: number;
  children: React.ReactNode;
}

export function SettingsCategoryGroup({ category, count, children }: SettingsCategoryGroupProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ponytail: hydrate after mount so the first client paint
  // matches SSR. Without the gate the group would jump from
  // expanded → collapsed on reload.
  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const isCollapsed = collapsed[category] === true;

  const toggle = () => {
    const next = { ...collapsed, [category]: !isCollapsed };
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!isCollapsed}
        aria-controls={`settings-cat-${category}`}
        className="w-full flex items-center justify-between gap-2 px-2 py-1 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)] hover:text-[var(--text-secondary)] rounded transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn(
              "w-3 h-3 transition-transform shrink-0",
              isCollapsed && "-rotate-90"
            )}
            aria-hidden
          />
          <span className="truncate">{category}</span>
          {typeof count === "number" && (
            <span className="text-[var(--text-faint)]">({count})</span>
          )}
        </span>
      </button>
      {!isCollapsed && (
        <div id={`settings-cat-${category}`} className="space-y-1">
          {children}
        </div>
      )}
    </div>
  );
}