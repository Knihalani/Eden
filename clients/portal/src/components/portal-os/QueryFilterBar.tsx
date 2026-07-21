"use client";

import { useEffect, useMemo, useState } from "react";
import { Filter, X, ChevronDown, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearedFilters, FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
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
  /** First-paint selects (Wave 4: ≤3). */
  selects?: Array<{
    key: string;
    label: string;
    options: Array<{ value: string; label: string }>;
    value: string;
  }>;
  /** Extra selects only in the Advanced drawer (facets, etc.). */
  advancedSelects?: Array<{
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

/**
 * Progressive filter chrome: Basic (search + ≤3 selects) is default.
 * Query language, Create alert, and advanced selects live in a drawer.
 */
export function QueryFilterBar({
  mode,
  onModeChange,
  filters,
  onFiltersChange,
  query,
  onQueryChange,
  selects = [],
  advancedSelects = [],
  onCreateAlert,
  sticky = false,
  className,
}: QueryFilterBarProps) {
  const density = useDensity();
  const [queryDraft, setQueryDraft] = useState(query);
  const [showSuggest, setShowSuggest] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Keep draft in sync when URL / parent `query` prop changes (saved views, back nav).
  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  // Opening Advanced with an existing query string enters query mode.
  useEffect(() => {
    if (advancedOpen && query.trim() && mode === "basic") {
      onModeChange("query");
    }
  }, [advancedOpen, query, mode, onModeChange]);

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

  const advancedActive =
    mode === "query" ||
    Boolean(query.trim()) ||
    advancedSelects.some((s) => Boolean(s.value));

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
        [...selects, ...advancedSelects].map((s) => s.key),
      ),
    );
    onModeChange("basic");
  };

  const mergeAdvancedFilters = (partial: Record<string, string>) => {
    onFiltersChange({ ...filters, ...partial });
  };

  return (
    <div
      className={cn(
        sticky && "sticky top-11 z-10",
        density === "compact"
          ? "space-y-space-1 [&_input]:py-space-1 [&_button]:py-space-1 text-sm"
          : "space-y-space-2",
        className,
      )}
      data-density={density}
      data-testid="query-filter-bar"
      data-filter-mode={mode}
    >
      <div
        className={cn(
          "flex flex-wrap items-start",
          density === "compact" ? "gap-space-1" : "gap-space-2",
        )}
      >
        <div className="min-w-0 flex-1">
          <FilterBar
            filters={filters}
            onChange={onFiltersChange}
            selects={selects}
            search={{
              value: query,
              onChange: onQueryChange,
              placeholder: "Search traces…",
              key: "q",
              // `/` focuses filter; ⌘K remains command palette (Wave 6).
              shortcutHint: "/",
            }}
            sticky={false}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 min-h-8 max-md:min-h-11 shrink-0"
          aria-expanded={advancedOpen}
          aria-controls="query-filter-advanced-panel"
          data-testid="query-filter-advanced-trigger"
          data-primary-control="advanced"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          Advanced
          {advancedActive ? (
            <span
              className="ml-1 h-1.5 w-1.5 rounded-full bg-[var(--warning)]"
              aria-label="Advanced filters active"
            />
          ) : null}
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform duration-[var(--duration-fast)]",
              advancedOpen && "rotate-180",
            )}
            aria-hidden
          />
        </Button>
      </div>

      {advancedOpen ? (
        <div
          id="query-filter-advanced-panel"
          data-testid="query-filter-advanced-panel"
          className="space-y-space-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-3"
          role="region"
          aria-label="Advanced filters"
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
                  {m === "query" ? "Query language" : "Basic"}
                </Button>
              ))}
            </div>
            {onCreateAlert && (
              <button
                type="button"
                onClick={onCreateAlert}
                className="text-xs text-[var(--accent)] hover:underline"
                data-testid="create-alert-from-filters"
              >
                Create alert from filters
              </button>
            )}
          </div>

          {advancedSelects.length > 0 ? (
            <FilterBar
              filters={filters}
              onChange={mergeAdvancedFilters}
              selects={advancedSelects}
              sticky={false}
            />
          ) : null}

          {mode === "query" ? (
            <div className="relative space-y-space-1">
              <div
                className={cn(
                  "flex flex-wrap items-center gap-space-3 rounded-xl border bg-[var(--bg-primary)] px-space-3 py-space-2",
                  parseError ? "border-[var(--error)]" : "border-[var(--border-default)]",
                )}
              >
                <Filter className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <Input
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
                  placeholder="latency:>2 agent:support status:error tag:prod"
                  aria-label="Query language filter"
                  aria-invalid={Boolean(parseError)}
                  aria-describedby={
                    parseError ? "query-lang-error" : "query-lang-docs"
                  }
                  className="min-w-[12rem] flex-1 font-mono"
                />
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-8 min-h-8 max-md:min-h-11"
                  onClick={applyQuery}
                >
                  Apply
                </Button>
                {(query || queryDraft || Object.values(filters).some(Boolean)) && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className={cn(
                      "inline-flex h-8 min-h-8 max-md:min-h-11 min-w-11 items-center justify-center gap-space-1 px-space-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg",
                      FOCUS_RING_CLASS,
                    )}
                  >
                    <X className="h-3.5 w-3.5" />
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
          ) : null}
        </div>
      ) : null}
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
        "inline-flex h-8 min-h-8 max-md:min-h-11 items-center gap-space-1 rounded-lg border px-2.5 py-1.5 text-xs",
        dirty
          ? "border-[var(--warning)] bg-[var(--warning-bg)] text-[var(--warning)]"
          : "border-[var(--border-default)] text-[var(--text-secondary)]",
      )}
      data-testid="views-menu-trigger"
      data-unsaved={dirty ? "true" : undefined}
    >
      {dirty ? "Unsaved" : label}
      <ChevronDown className="h-3 w-3" />
    </span>
  );
}
