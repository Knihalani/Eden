"use client";

import { Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

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
  /** Stick under shell header (`h-11`); uses `py-space-2` min padding. */
  sticky?: boolean;
  className?: string;
}

/**
 * Reset every key in `filters` plus any select keys not yet present.
 * Prevents filter-only keys (e.g. agent_id) from surviving Clear when
 * they are not represented as selects.
 */
export function clearedFilters(
  filters: Record<string, string>,
  selectKeys: string[] = [],
): Record<string, string> {
  const cleared: Record<string, string> = {};
  for (const key of Object.keys(filters)) cleared[key] = "";
  for (const key of selectKeys) cleared[key] = "";
  return cleared;
}

/**
 * FilterBar — search input + filter dropdowns + clear-all button.
 * Spacing rhythm: `p-space-3` / `gap-space-3` (w3-spacing-tokens §5.3).
 */
export function FilterBar({
  filters,
  onChange,
  selects = [],
  search,
  sticky = false,
  className,
}: FilterBarProps) {
  const hasActiveFilters = Object.values(filters).some(Boolean) || Boolean(search?.value);

  const appliedChips: Array<{ key: string; label: string }> = [];
  for (const s of selects) {
    if (!s.value) continue;
    const opt = s.options.find((o) => o.value === s.value);
    appliedChips.push({ key: s.key, label: `${s.label}: ${opt?.label ?? s.value}` });
  }
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    if (selects.some((s) => s.key === key)) continue;
    appliedChips.push({ key, label: `${key}: ${value}` });
  }
  if (search?.value) {
    appliedChips.push({ key: search.key ?? "q", label: `Search: ${search.value}` });
  }

  function setFilter(key: string, value: string) {
    onChange({ ...filters, [key]: value });
  }

  function clearAll() {
    onChange(clearedFilters(filters, selects.map((s) => s.key)));
    search?.onChange("");
  }

  return (
    <div className={cn("space-y-space-2", sticky && "sticky top-11 z-10")}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-space-3 bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-lg px-space-3",
          sticky ? "py-space-2" : "py-space-3",
          className,
        )}
      >
        <Filter className="w-4 h-4 text-[var(--text-muted)]" />
        {selects.map((s) => (
          <select
            key={s.key}
            value={s.value}
            onChange={(e) => setFilter(s.key, e.target.value)}
            aria-label={`${s.label} filter`}
            className={cn(
              "min-h-11 px-space-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg text-sm text-[var(--text-primary)]",
              FOCUS_RING_CLASS,
            )}
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
            aria-label={search.placeholder ?? "Search filters"}
            className={cn(
              "min-h-11 px-space-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]",
              FOCUS_RING_CLASS,
            )}
          />
        )}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAll}
            className={cn(
              "ml-auto inline-flex items-center justify-center gap-space-1 px-space-2 min-h-11 min-w-11 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]",
              FOCUS_RING_CLASS,
            )}
            aria-label="Clear all filters"
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>
      {appliedChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-space-2" aria-label="Applied filters">
          {appliedChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cn(
                "inline-flex items-center gap-space-1 min-h-11 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-space-3 py-space-1 text-xs text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]",
                FOCUS_RING_CLASS,
              )}
              aria-label={`Remove filter ${chip.label}`}
              onClick={() => {
                if (chip.key === (search?.key ?? "q") && search) {
                  search.onChange("");
                  return;
                }
                setFilter(chip.key, "");
              }}
            >
              {chip.label}
              <X className="w-3 h-3 shrink-0" aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
