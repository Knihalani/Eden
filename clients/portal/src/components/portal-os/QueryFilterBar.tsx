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

  return (
    <div
      className={cn(
        "space-y-2",
        density === "compact" && "[&_input]:py-1 [&_button]:py-0.5 text-sm",
        className,
      )}
      data-density={density}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[var(--border-default)] p-0.5 text-xs">
          {(["basic", "query"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={cn(
                "px-2.5 py-1 rounded-md capitalize min-h-[44px] sm:min-h-0",
                mode === m
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {m}
            </button>
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
        />
      ) : (
        <div className="relative space-y-1">
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 bg-[var(--bg-primary)] border rounded-xl p-3",
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
              className="flex-1 min-w-[12rem] px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
            <button
              type="button"
              onClick={applyQuery}
              className="px-3 py-1.5 text-xs rounded-lg bg-[var(--accent)] text-[var(--bg-primary)]"
            >
              Apply
            </button>
            {(query || queryDraft || Object.values(filters).some(Boolean)) && (
              <button
                type="button"
                onClick={() => {
                  setQueryDraft("");
                  onQueryChange("");
                  onFiltersChange(
                    clearedFilters(
                      filters,
                      selects.map((s) => s.key),
                    ),
                  );
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
          {parseError && (
            <p
              id="query-lang-error"
              className="text-[10px] text-[var(--error)] underline decoration-wavy"
            >
              {parseError}
            </p>
          )}
          <p id="query-lang-docs" className="text-[10px] text-[var(--text-muted)]">
            Fields: {QUERY_LANGUAGE_FIELDS.map((f) => f.field).join(", ")}
          </p>
          {showSuggest && suggestions.length > 0 && (
            <ul
              className="absolute z-20 mt-1 max-h-40 w-full overflow-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg"
              role="listbox"
              aria-label="Query field suggestions"
            >
              {suggestions.slice(0, 8).map((s) => (
                <li key={s.label}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--bg-tertiary)]"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setQueryDraft(s.insert);
                      setShowSuggest(false);
                    }}
                  >
                    <span className="font-mono text-[var(--accent)]">{s.label}</span>
                    <span className="ml-2 text-[var(--text-muted)]">{s.docs}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === "query" && query && (
        <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">
          Active: {query}
        </p>
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
        "inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border",
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
