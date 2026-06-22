"use client";

/**
 * SettingsSearch — search input for the Settings tab rail.
 *
 * Filters tabs by label substring (case-insensitive). Hides
 * non-matching tabs AND their category headers so the rail
 * doesn't show empty groups.
 *
 * June 2026 cleanup — Settings had 17 tabs in one flat list;
 * adding search makes every tab reachable in <2 keystrokes.
 */

import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsSearchProps {
  value: string;
  onChange: (next: string) => void;
  /** Total visible / total tabs, e.g. "Showing 3 of 17". */
  totalLabel?: string;
  className?: string;
}

export function SettingsSearch({ value, onChange, totalLabel, className }: SettingsSearchProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none"
          aria-hidden
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          // P12: hide WebKit/Chromium's native `type=search` clear
          // affordance so we don't render two stacked X buttons.
          // The custom X below is keyboard-reachable, focusable,
          // and announced as "Clear search" by AT.
          className="w-full pl-9 pr-9 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)] [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {totalLabel && (
        // P25: bumped from 11px to xs (12px) for legibility.
        <p className="text-xs text-[var(--text-muted)] px-1" aria-live="polite">
          {totalLabel}
        </p>
      )}
    </div>
  );
}