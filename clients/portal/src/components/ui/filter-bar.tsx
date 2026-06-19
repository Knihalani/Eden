"use client";

import { Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface FilterBarProps {
  /** Current filter state — passed back via onChange. */
  filters: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** Optional list of dropdown definitions. */
  selects?: Array<{
    key: string;
    label: string;
    options: Array<{ value: string; label: string }>;
    value: string;
  }>;
  /** Optional search input on the right side. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string; key?: string };
  className?: string;
}

/**
 * FilterBar — search input + filter dropdowns + clear-all button.
 * Replaces the "flex flex-wrap items-center gap-3 bg-[var(--bg-primary)]
 * border border-[var(--border-default)] rounded-xl p-3" pattern
 * that was copy-pasted across observability, incidents, alerts, etc.
 *
 * Phase 7 of the June 2026 UI overhaul.
 */
export function FilterBar({ filters, onChange, selects = [], search, className }: FilterBarProps) {
  const hasActiveFilters = Object.values(filters).some(Boolean) || Boolean(search?.value);

  function setFilter(key: string, value: string) {
    onChange({ ...filters, [key]: value });
  }

  function clearAll() {
    const cleared: Record<string, string> = {};
    for (const s of selects) cleared[s.key] = "";
    onChange(cleared);
    search?.onChange("");
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-3",
        className
      )}
    >
      <Filter className="w-4 h-4 text-[var(--text-muted)]" />
      {selects.map((s) => (
        <select
          key={s.key}
          value={s.value}
          onChange={(e) => setFilter(s.key, e.target.value)}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">{s.label}</option>
          {s.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ))}
      {search && (
        <input
          type="text"
          placeholder={search.placeholder ?? "Search…"}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      )}
      {hasActiveFilters && (
        <button
          onClick={clearAll}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-tertiary)]"
          aria-label="Clear all filters"
        >
          <X className="w-3.5 h-3.5" />
          Clear
        </button>
      )}
    </div>
  );
}
