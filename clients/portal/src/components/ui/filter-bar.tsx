"use client";

import { Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDensity } from "@/components/portal-os/DensityProvider";

/** Sentinel for “all / unset” — Radix Select disallows empty string values. */
const SELECT_ALL = "__all__";

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
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    key?: string;
    /** Show a quiet kbd chip (e.g. `/`) — Traces hub Wave 6. */
    shortcutHint?: string;
  };
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
 * Spacing rhythm: comfortable `p-space-3` / `gap-space-3`; compact tightens.
 * Control height: `h-8` desktop / `max-md:min-h-11` touch (DESIGN.md density).
 */
export function FilterBar({
  filters,
  onChange,
  selects = [],
  search,
  sticky = false,
  className,
}: FilterBarProps) {
  const density = useDensity();
  const compact = density === "compact";
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
          "flex flex-wrap items-center bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-lg",
          compact
            ? "gap-space-2 px-space-2"
            : "gap-space-3 px-space-3",
          sticky
            ? compact
              ? "py-space-1"
              : "py-space-2"
            : compact
              ? "py-space-2"
              : "py-space-3",
          className,
        )}
        data-density={density}
      >
        <Filter className="w-4 h-4 text-[var(--text-muted)]" />
        {selects.map((s) => (
          <Select
            key={s.key}
            value={s.value || SELECT_ALL}
            onValueChange={(v) => setFilter(s.key, v === SELECT_ALL ? "" : v)}
          >
            <SelectTrigger
              aria-label={`${s.label} filter`}
              className="w-auto min-w-[8rem]"
            >
              <SelectValue placeholder={s.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_ALL}>{s.label}</SelectItem>
              {s.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {search && (
          <div className="relative inline-flex min-w-[12rem] flex-1 items-center">
            <Input
              type="text"
              placeholder={search.placeholder ?? "Search…"}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              aria-label={search.placeholder ?? "Search filters"}
              data-testid="filter-bar-search"
              data-filter-search
              className={cn(
                "h-8 min-h-8 w-full min-w-[12rem] max-md:min-h-11",
                search.shortcutHint && "pr-8",
              )}
            />
            {search.shortcutHint ? (
              <kbd
                className="pointer-events-none absolute right-2 hidden sm:inline-block rounded border border-[var(--border-subtle)] px-1 py-0.5 font-mono text-xs text-[var(--text-muted)]"
                data-shortcut-chip="filter-focus"
                aria-hidden
              >
                {search.shortcutHint}
              </kbd>
            ) : null}
          </div>
        )}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAll}
            className={cn(
              "ml-auto inline-flex items-center justify-center gap-space-1 px-space-2 h-8 min-h-8 max-md:min-h-11 min-w-11 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]",
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
        <div
          className={cn(
            "flex flex-wrap items-center",
            compact ? "gap-space-1" : "gap-space-2",
          )}
          aria-label="Applied filters"
        >
          {appliedChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cn(
                "inline-flex items-center gap-space-1 h-8 min-h-8 max-md:min-h-11 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-space-3 py-space-1 text-xs text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]",
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
