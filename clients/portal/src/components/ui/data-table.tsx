"use client";

/**
 * DataTable — shadcn-style primitive for the 10+ tables in the
 * portal that would otherwise reinvent the wheel.
 *
 * Supports: column defs, sort, pagination, row selection / bulk
 * action, custom cell render, empty state, loading state, and an
 * action cell. Use the existing `Table` from `./table` for the
 * inner shell; this is the API surface the rest of the portal
 * uses.
 *
 * Why a single primitive: the audit (June 2026) counted 16 table
 * pages and 27 with `overflow-x-auto`. Most reimplement sort/page
 * state by hand. This is the minimum useful surface that covers
 * all of them — feature additions belong in a new primitive, not
 * here.
 */

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Inbox,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { STICKY_FIRST_TD, STICKY_FIRST_TH } from "@/components/ui/table-sticky";

// ── Public types ──────────────────────────────────────────────────

export interface DataTableColumn<T> {
  /** Unique key for sort + React key. */
  key: string;
  /** Header text. */
  header: string;
  /** Cell renderer; falls back to `String(row[key])`. */
  cell?: (row: T) => React.ReactNode;
  /** When set, makes the column sortable. */
  sortable?: boolean;
  /** Tailwind class on both th and td. */
  className?: string;
  /** Tailwind class on the th only. */
  headerClassName?: string;
  /** Text alignment. */
  align?: "left" | "right" | "center";
  /** Pin the column to the left edge during horizontal scroll. */
  sticky?: boolean;
}

export interface DataTableBulkAction<T> {
  label: string;
  variant?: "default" | "destructive";
  /** Return false to disable the action for the current selection. */
  enabled?: (rows: T[]) => boolean;
  onClick: (rows: T[]) => void | Promise<void>;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable id; falls back to index. */
  rowKey?: (row: T, index: number) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Custom icon for the empty state. Defaults to `Inbox`. */
  emptyIcon?: LucideIcon;
  /** CTA rendered inside the empty state (e.g. "Create", "Run clustering"). */
  emptyAction?: React.ReactNode;
  /** Forwarded to EmptyState. The `terminal` variant replaces the icon
   *  with a "what data would look like" preview slot. */
  emptyVariant?: "panel" | "plain" | "terminal";
  /** Forwarded to EmptyState — mock log line, sparkline preview, etc. */
  emptyTerminal?: React.ReactNode;
  // Sort
  defaultSort?: { key: string; direction: "asc" | "desc" };
  onSortChange?: (sort: { key: string; direction: "asc" | "desc" } | null) => void;
  // Page
  pageSize?: number;
  // Selection
  selectable?: boolean;
  bulkActions?: DataTableBulkAction<T>[];
  // Row
  onRowClick?: (row: T) => void;
  /** Per-row HTML attributes (e.g. `data-trace-id`). Useful for tests / e2e selectors. */
  rowAttrs?: (row: T, index: number) => Record<string, string | number | boolean | undefined>;
  /** Highlight a single row by id (e.g. deep-link pre-selection). */
  highlightRowId?: string;
  // Style
  className?: string;
}

// ── Helpers ───────────────────────────────────────────────────────

function alignClass(align: DataTableColumn<unknown>["align"]) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function defaultCompare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// ── Component ─────────────────────────────────────────────────────

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyTitle = "No results",
  emptyDescription = "Nothing to show here yet.",
  emptyIcon,
  emptyAction,
  emptyVariant,
  emptyTerminal,
  defaultSort,
  onSortChange,
  pageSize = 25,
  selectable = false,
  bulkActions,
  onRowClick,
  rowAttrs,
  highlightRowId,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<{ key: string; direction: "asc" | "desc" } | null>(
    defaultSort ?? null
  );
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Reset page when row count changes (e.g. after filter).
  React.useEffect(() => {
    setPage(0);
  }, [rows.length]);

  const keyOf = React.useCallback(
    (row: T, i: number) => (rowKey ? rowKey(row, i) : String(i)),
    [rowKey]
  );

  // Sort keys off column identity (keys), not array reference — parents often
  // rebuild `columns` each render even when keys are unchanged (W12).
  const columnKeySig = columns.map((c) => c.key).join("\0");
  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const out = [...rows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort.key];
      const bv = (b as Record<string, unknown>)[sort.key];
      const cmp = defaultCompare(av, bv);
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return out;
    // columns consulted inside; columnKeySig gates identity churn
    // eslint-disable-next-line react-hooks/exhaustive-deps -- W12 column identity
  }, [rows, sort, columnKeySig]);

  // ── Page
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paged = React.useMemo(
    () => sorted.slice(page * pageSize, (page + 1) * pageSize),
    [sorted, page, pageSize]
  );

  // ── Selection
  const allOnPageSelected =
    paged.length > 0 && paged.every((r, i) => selected.has(keyOf(r, page * pageSize + i)));
  const someOnPageSelected = paged.some((r, i) => selected.has(keyOf(r, page * pageSize + i)));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allOnPageSelected) {
      paged.forEach((r, i) => next.delete(keyOf(r, page * pageSize + i)));
    } else {
      paged.forEach((r, i) => next.add(keyOf(r, page * pageSize + i)));
    }
    setSelected(next);
  };
  const toggleRow = (k: string) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };

  const setSortKey = (key: string) => {
    const next: { key: string; direction: "asc" | "desc" } | null =
      !sort || sort.key !== key
        ? { key, direction: "asc" }
        : sort.direction === "asc"
        ? { key, direction: "desc" }
        : null;
    setSort(next);
    onSortChange?.(next);
  };

  const selectedRows = React.useMemo(
    () => rows.filter((r, i) => selected.has(keyOf(r, i))),
    [rows, selected, keyOf]
  );

  // ── Render
  return (
    <div className={cn("space-y-3", className)}>
      {selectable && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--accent-faint)] px-3 py-2 text-sm">
          <span className="font-medium text-[var(--text-primary)]">
            {selected.size} selected
          </span>
          {(bulkActions ?? []).map((action, i) => {
            const enabled = action.enabled?.(selectedRows) ?? true;
            return (
              <Button
                key={i}
                size="sm"
                variant={action.variant === "destructive" ? "destructive" : "outline"}
                disabled={!enabled}
                onClick={() => action.onClick(selectedRows)}
              >
                {action.label}
              </Button>
            );
          })}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="relative w-full overflow-auto rounded-md border border-[var(--border-default)]">
        <table className="w-full caption-bottom text-sm">
          <thead className="[&_tr]:border-b">
            <tr className="border-b border-[var(--border-default)]">
              {selectable && (
                <th className="h-11 w-11 p-0 text-left align-middle">
                  <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      aria-label="Select all on page"
                      checked={allOnPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected;
                      }}
                      onChange={toggleAll}
                      className="h-4 w-4 cursor-pointer"
                    />
                  </label>
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "h-10 px-3 align-middle font-medium text-[var(--text-secondary)]",
                    alignClass(col.align),
                    col.headerClassName,
                    col.sticky && STICKY_FIRST_TH
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => setSortKey(col.key)}
                      className={cn(
                        "inline-flex items-center gap-1 hover:text-[var(--text-primary)]",
                        sort?.key === col.key && "text-[var(--accent)]"
                      )}
                    >
                      {col.header}
                      {sort?.key === col.key && sort.direction === "asc" && (
                        <ChevronUp className="h-3.5 w-3.5" />
                      )}
                      {sort?.key === col.key && sort.direction === "desc" && (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: Math.min(pageSize, 5) }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-[var(--border-subtle)]">
                  {selectable && <td className="px-3 py-3"><Skeleton className="h-4 w-4" /></td>}
                  {columns.map((col) => (
                    <td key={col.key} className={cn("px-3 py-3", alignClass(col.align), col.className)}>
                      <Skeleton className="h-4 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="p-0">
                  <EmptyState
                    icon={emptyIcon ?? Inbox}
                    title={emptyTitle}
                    description={emptyDescription}
                    size="sm"
                    action={emptyAction}
                    variant={emptyVariant}
                    terminal={emptyTerminal}
                    className="m-6"
                  />
                </td>
              </tr>
            ) : (
              paged.map((row, i) => {
                const k = keyOf(row, page * pageSize + i);
                const isSelected = selected.has(k);
                const isHighlighted = !!highlightRowId && highlightRowId === k;
                const extraAttrs = rowAttrs?.(row, page * pageSize + i);
                return (
                  <tr
                    key={k}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "border-b border-[var(--border-subtle)] transition-colors",
                      onRowClick && "cursor-pointer hover:bg-[var(--accent-faint)]/50",
                      (isSelected || isHighlighted) && "bg-[var(--accent-faint)] hover:bg-[var(--accent-faint)]"
                    )}
                    data-state={isSelected ? "selected" : undefined}
                    {...(extraAttrs ?? {})}
                  >
                    {selectable && (
                      <td
                        className="w-11 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRow(k);
                        }}
                      >
                        <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            aria-label={`Select row ${k}`}
                            checked={isSelected}
                            onChange={() => toggleRow(k)}
                            className="h-4 w-4 cursor-pointer"
                          />
                        </label>
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "px-3 py-3 align-middle",
                          alignClass(col.align),
                          col.className,
                          col.sticky && STICKY_FIRST_TD
                        )}
                      >
                        {col.cell
                          ? col.cell(row)
                          : String((row as Record<string, unknown>)[col.key] ?? "")}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
          <div>
            Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} of{" "}
            {sorted.length}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="px-2">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export a search input bound to a string for convenience.
export function DataTableSearch({
  value,
  onChange,
  placeholder = "Filter…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="max-w-xs"
      aria-label={placeholder}
    />
  );
}
