"use client";

/**
 * SettingsSearch — Stripe/Linear search-first bar for the Settings rail.
 *
 * Filters tabs by label + keyword substring (case-insensitive).
 * Parent hides non-matching tabs and empty category groups.
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
    <div className={cn("space-y-space-2", className)}>
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none"
          aria-hidden
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search settings… (api, billing, pii)"
          aria-label="Search settings"
          autoComplete="off"
          spellCheck={false}
          // Hide native search clear so the custom X is the only affordance.
          className="w-full min-h-11 pl-9 pr-9 py-space-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:border-[var(--accent)] [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>
      {totalLabel ? (
        <p className="text-xs text-[var(--text-muted)] px-space-1" aria-live="polite">
          {totalLabel}
        </p>
      ) : null}
    </div>
  );
}
