"use client";

import { useEffect, useMemo, useState } from "react";
import { Filter, X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearedFilters, FilterBar } from "@/components/ui/filter-bar";
import {
  parseQueryLanguage,
  suggestQueryCompletions,
  QUERY_LANGUAGE_FIELDS,
} from "@/lib/query-language";
import { useDensity } from "./DensityProvider";
import { Button } from "@/components/ui/button";

export type FilterMode = "basic" | "query";

export interface QueryFilterBarProps {
  mode: FilterMode;
  onModeChange: (mode: FilterMode) => void;
  filters: Record<string, string>;
  onFiltersChange: (next: Record<string, string>) => void;
  query: string;
  onQueryChange: (q: string) => void;
  selects?: Array<{
    key: string;
    label: string;
    options: Array<{ value: string; label: string }>;
    value: string;
  }>;
  onCreateAlert?: () => void;
  /** Stick under shell header (`h-11`); uses `py-space-2` min padding on the bar. */
  sticky?: boolean;
  className?: string;
}

export function QueryFilterBar({
  mode,
  onModeChange,
  filters,
  onFiltersChange,
  query,
  onQueryChange,
  selects = [],
  onCreateAlert,
  sticky = false,
  className,
}: QueryFilterBarProps) {
  const density = useDensity();
  const [queryDraft, setQueryDraft] = useState(query);
  const [showSuggest, setShowSuggest] = useState(false);

  // Keep draft in sync when URL / parent `query` prop changes (saved views, back nav).
  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  const suggestions = useMemo(
    () => (showSuggest ? suggestQueryCompletions(queryDraft) : []),
    [queryDraft, showSuggest],
  );

  const parseError = useMemo(() => {
    const trimmed = queryDraft.trim();
    if (!trimmed) return null;
    const unknown = trimmed.match(/\b([a-zA-Z_][\w.]*):/g);
    if (!unknown) return null;
    const known = new Set(QUERY_LANGUAGE_FIELDS.map((f) => f.field));
    known.add("agent_id");
    known.add("outcome");
    known.add("user_id");
    known.add("duration");
    known.add("cost_usd");
    for (const tok of unknown) {
      const field = tok.slice(0, -1).toLowerCase();
      if (!known.has(field)) return `Unknown field: ${field}`;
    }
    return null;
  }, [queryDraft]);

  const appliedChips = useMemo(() => {
    const chips: Array<{ key: string; label: string }> = [];
    if (mode === "query" && query) {
      chips.push({ key: "q", label: query });
    }
    for (const s of selects) {
      if (!s.value) continue;
      const opt = s.options.find((o) => o.value === s.value);
      chips.push({ key: s.key, label: `${s.label}: ${opt?.label ?? s.value}` });
    }
    for (const [key, value] of Object.entries(filters)) {
      if (!value) continue;
      if (selects.some((s) => s.key === key)) continue;
      chips.push({ key, label: `${key}: ${value}` });
    }
    return chips;
  }, [mode, query, filters, selects]);

  const applyQuery = () => {
    onQueryChange(queryDraft.trim());
    const parsed = parseQueryLanguage(queryDraft);
    const next = { ...filters };
    if (parsed.agent_id) next.agent_id = parsed.agent_id;
    if (parsed.outcome) next.outcome = parsed.outcome;
    if (parsed.realm) next.realm = parsed.realm;
    onFiltersChange(next);
    setShowSuggest(false);
  };

  const clearAll = () => {
    setQueryDraft("");
    onQueryChange("");
    onFiltersChange(
      clearedFilters(
        filters,
        selects.map((s) => s.key),
      ),
    );
  };

  return (
    <div
      className={cn(
        "space-y-space-2",
        sticky && "sticky top-11 z-10",
        density === "compact" && "[&_input]:py-space-1 [&_button]:py-space-1 text-sm",
        className,
      )}
      data-density={density}
    >
      <div className="flex flex-wrap items-center gap-space-3">
        <div className="inline-flex rounded-lg border border-[var(--border-default)] p-space-1 text-xs">
          {(["basic", "query"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              variant={mode === m ? "default" : "ghost"}
              size="sm"
              onClick={() => onModeChange(m)}
              className="capitalize min-h-[44px] sm:min-h-0"
            >
              {m}
            </Button>
          ))}
        </div>
        {onCreateAlert && (
          <button
            type="button"
            onClick={onCreateAlert}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            Create alert from filters
          </button>
        )}
      </div>

      {mode === "basic" ? (
        <FilterBar
          filters={filters}
          onChange={onFiltersChange}
          selects={selects}
          sticky={false}
        />
      ) : (
        <div className="relative space-y-space-1">
          <div
            className={cn(
              "flex flex-wrap items-center gap-space-3 bg-[var(--bg-primary)] border rounded-xl px-space-3",
              sticky ? "py-space-2" : "py-space-3",
              parseError ? "border-[var(--error)]" : "border-[var(--border-default)]",
            )}
          >
            <Filter className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
            <input
              type="text"
              value={queryDraft}
              onChange={(e) => {
                setQueryDraft(e.target.value);
                setShowSuggest(true);
              }}
              onFocus={() => setShowSuggest(true)}
              onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyQuery();
              }}
              placeholder='latency:>2 agent:support status:error tag:prod'
              aria-label="Query language filter"
              aria-invalid={Boolean(parseError)}
              aria-describedby={parseError ? "query-lang-error" : "query-lang-docs"}
              className="flex-1 min-w-[12rem] px-space-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
            <Button type="button" variant="default" size="sm" className="min-h-11" onClick={applyQuery}>
              Apply
            </Button>
            {(query || queryDraft || Object.values(filters).some(Boolean)) && (
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex items-center justify-center gap-space-1 px-space-2 min-h-11 min-w-11 sm:min-h-6 sm:min-w-6 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
          {parseError && (
            <p
              id="query-lang-error"
              className="text-xs text-[var(--error)] underline decoration-wavy"
            >
              {parseError}
            </p>
          )}
          <p id="query-lang-docs" className="text-xs text-[var(--text-muted)]">
            Fields: {QUERY_LANGUAGE_FIELDS.map((f) => f.field).join(", ")}
          </p>
          {showSuggest && suggestions.length > 0 && (
            <ul
              className="absolute z-20 mt-space-1 max-h-40 w-full overflow-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg"
              role="listbox"
              aria-label="Query field suggestions"
            >
              {suggestions.slice(0, 8).map((s) => (
                <li key={s.label}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="w-full px-space-3 py-1.5 text-left text-xs hover:bg-[var(--bg-tertiary)]"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setQueryDraft(s.insert);
                      setShowSuggest(false);
                    }}
                  >
                    <span className="font-mono text-[var(--accent)]">{s.label}</span>
                    <span className="ml-space-2 text-[var(--text-muted)]">{s.docs}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === "query" && appliedChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-space-2" aria-label="Applied filters">
          {appliedChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex max-w-full items-center truncate rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-2 py-space-1 text-xs font-mono text-[var(--text-secondary)]"
              title={chip.label}
            >
              {chip.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ViewsMenuTrigger({
  dirty,
  label = "Views",
}: {
  dirty?: boolean;
  label?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-space-1 min-h-11 px-2.5 py-1.5 text-xs rounded-lg border",
        dirty
          ? "border-[var(--warning)] text-[var(--warning)] bg-[var(--warning-bg)]"
          : "border-[var(--border-default)] text-[var(--text-secondary)]",
      )}
    >
      {label}
      <ChevronDown className="w-3 h-3" />
    </span>
  );
}
