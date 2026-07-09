"use client";

import * as React from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarItem } from "@/lib/sidebar-config";

/**
 * SidebarSearch — local fuzzy filter for the sidebar nav.
 *
 * With 30+ items across 5 groups (Build / Observe / Optimize /
 * Automate / Workspace), scanning the list takes a moment. This
 * component renders an inline search input that filters items by
 * label match. Hidden items (category: "advanced") are excluded
 * from results when advanced mode is collapsed.
 *
 * Activated: type. Cleared: Esc, X button, or click outside.
 * Keyboard nav: ArrowDown/Up to walk results, Enter to navigate.
 *
 * The command palette (Cmd+K) still covers actions; this is for
 * route discovery only.
 */
export interface SidebarSearchProps {
  items: SidebarItem[];
  /** Excluded item ids (advanced toggle collapsed). */
  hiddenIds?: Set<string>;
  className?: string;
}

function flatten(items: SidebarItem[]): SidebarItem[] {
  const out: SidebarItem[] = [];
  const walk = (xs: SidebarItem[]) => {
    for (const it of xs) {
      out.push(it);
      if (it.children) walk(it.children);
    }
  };
  walk(items);
  return out;
}

function matches(query: string, label: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // Token match: every space-separated query token must appear in
  // the label (substring). Keeps matches readable — "inc rev" finds
  // "PR Suggestions" via the r/e/v tokens, "trace rep" finds
  // "Replay", etc.
  return q
    .split(/\s+/)
    .every((t) => label.toLowerCase().includes(t));
}

export function SidebarSearch({ items, hiddenIds, className }: SidebarSearchProps) {
  const [query, setQuery] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Flatten + filter on every keystroke.
  const all = React.useMemo(() => flatten(items), [items]);
  const filtered = React.useMemo(() => {
    if (!query.trim()) return [] as SidebarItem[];
    return all
      .filter((it) => !hiddenIds?.has(it.id))
      .filter((it) => matches(query, it.label))
      .slice(0, 8);
  }, [all, query, hiddenIds]);

  // Reset active index whenever the result set changes.
  React.useEffect(() => setActiveIdx(0), [query]);

  // Click-outside dismisses the result panel.
  React.useEffect(() => {
    function onDown(e: MouseEvent) {
      const root = containerRef.current;
      if (root && !root.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const showResults = focused && query.trim().length > 0 && filtered.length > 0;

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      setFocused(false);
      inputRef.current?.blur();
      return;
    }
    if (!showResults) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activeIdx];
      if (target) {
        // We don't have router here; the parent renders this input
        // and the Link results are real <Link>s so clicks navigate
        // normally. Keyboard Enter just opens the focused result.
        const links = containerRef.current?.querySelectorAll<HTMLAnchorElement>(
          '[data-sidebar-search-result]'
        );
        links?.[activeIdx]?.click();
      }
    }
  }

  return (
    <div ref={containerRef} className={cn("relative px-3 pt-2 pb-1", className)}>
      <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] focus-within:border-[var(--border-default)] focus-within:bg-[var(--bg-tertiary)] transition-colors">
        <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocused(true);
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKey}
          placeholder="Search the sidebar…"
          aria-label="Search sidebar items"
          // Autocomplete off — this is route discovery, not form data.
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:ring-0"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
      </label>

      {showResults && (
        <div
          role="listbox"
          aria-label="Sidebar search results"
          className="absolute left-3 right-3 top-full mt-1 z-40 rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-xl overflow-hidden"
        >
          {filtered.map((item, idx) => {
            const Icon = item.icon;
            const isActive = idx === activeIdx;
            return (
              <Link
                key={item.id}
                href={item.href}
                data-sidebar-search-result
                role="option"
                aria-selected={isActive}
                onClick={() => setFocused(false)}
                onMouseEnter={() => setActiveIdx(idx)}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 text-xs transition-colors",
                  isActive
                    ? "bg-[var(--accent-faint)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                )}
              >
                <Icon
                  className={cn(
                    "w-3.5 h-3.5 shrink-0",
                    isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
                  )}
                  aria-hidden
                />
                <span className="truncate flex-1">{item.label}</span>
                <span className="text-[10px] font-mono text-[var(--text-faint)] truncate max-w-[40%]">
                  {item.href}
                </span>
              </Link>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-xs text-[var(--text-muted)] text-center">
              No matches.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
