"use client";

import * as React from "react";
import { ChevronRight, Search } from "lucide-react";
import type { TranscriptRow } from "@/lib/observability/types";
import { filterSpanTreeKeepingAncestors } from "@/lib/observability/build-transcript-rows";
import { isInternalFrameworkSpan } from "@/lib/observability/elide";
import { classifySpanKind, spanKindColor } from "@/components/transcript-v2/span-kind";
import { formatDuration } from "@/components/transcript-v2/transcript-format";
import { cn } from "@/lib/utils";

function formatTokens(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function formatCostUsd(usd: number | null | undefined): string | null {
  if (usd == null) return null;
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function filterInternal(rows: TranscriptRow[]): TranscriptRow[] {
  const walk = (rs: TranscriptRow[]): TranscriptRow[] => {
    const out: TranscriptRow[] = [];
    for (const r of rs) {
      if (isInternalFrameworkSpan(r.name)) continue;
      const child = r.children ? walk(r.children) : undefined;
      out.push({ ...r, children: child });
    }
    return out;
  };
  return walk(rows);
}

function SpanNavNode({
  node,
  depth,
  selectedSpanId,
  onSpanSelect,
  forceOpen,
}: {
  node: TranscriptRow;
  depth: number;
  selectedSpanId?: string | null;
  onSpanSelect?: (spanId: string) => void;
  forceOpen?: boolean;
}) {
  const kids = node.children ?? [];
  const [open, setOpen] = React.useState(depth < 2);
  const expanded = forceOpen || open;
  const selected = selectedSpanId != null && selectedSpanId === node.span_id;
  const kind = classifySpanKind(node);
  const rail = spanKindColor(kind);
  const tokens =
    node.input_tokens != null || node.output_tokens != null
      ? `${formatTokens(node.input_tokens ?? 0) ?? "0"}→${formatTokens(node.output_tokens ?? 0) ?? "0"}`
      : null;
  const cost = formatCostUsd(node.cost_usd ?? null);

  return (
    <li>
      <div
        className={cn(
          "group flex items-stretch gap-0 rounded-sm hover:bg-[var(--bg-tertiary)]/60",
          selected && "bg-[var(--bg-tertiary)]",
        )}
        style={{ paddingLeft: `${depth * 0.65}rem` }}
      >
        <span
          className="w-0.5 shrink-0 self-stretch rounded-full"
          style={{ background: rail }}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1">
          {kids.length > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
              className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <ChevronRight
                className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
              />
            </button>
          ) : (
            <span className="inline-block w-3 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => onSpanSelect?.(node.span_id)}
            aria-current={selected ? "true" : undefined}
            data-span-id={node.span_id}
          >
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]"
              title={node.name}
            >
              {node.name}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
              <span>{formatDuration(node.duration_ms)}</span>
              {tokens ? <span className="hidden xl:inline opacity-80">{tokens}</span> : null}
              {cost ? <span className="hidden 2xl:inline opacity-80">{cost}</span> : null}
            </span>
          </button>
        </div>
      </div>
      {expanded && kids.length > 0 ? (
        <ul>
          {kids.map((child) => (
            <SpanNavNode
              key={child.span_id}
              node={child}
              depth={depth + 1}
              selectedSpanId={selectedSpanId}
              onSpanSelect={onSpanSelect}
              forceOpen={forceOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface SpanNavTreeProps {
  roots: TranscriptRow[];
  selectedSpanId: string | null;
  onSpanSelect: (spanId: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
}

/** Always-on left span navigation — hierarchical, searchable. */
export function SpanNavTree({
  roots,
  selectedSpanId,
  onSpanSelect,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
  className,
}: SpanNavTreeProps) {
  const visible = React.useMemo(() => filterInternal(roots), [roots]);
  const filtered = React.useMemo(
    () => filterSpanTreeKeepingAncestors(visible, searchQuery),
    [visible, searchQuery],
  );
  const searching = searchQuery.trim().length > 0;

  return (
    <nav
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden border-r border-[var(--border-default)] bg-[var(--bg-secondary)]",
        className,
      )}
      data-testid="span-nav-tree"
      aria-label="Span navigation"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2"
        data-testid="trace-span-search"
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="Filter spans… (/ or ⌘F)"
          aria-label="Search spans"
          data-testid="trace-tree-search"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        {searching ? (
          <span className="shrink-0 text-2xs text-[var(--text-muted)]">
            {filtered.length === 0 ? "No matches" : "Path kept"}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-[var(--text-muted)]">
            {searching ? "No spans match this filter." : "No spans in tree."}
          </p>
        ) : (
          <ul className="space-y-px p-1.5">
            {filtered.map((node) => (
              <SpanNavNode
                key={node.span_id}
                node={node}
                depth={0}
                selectedSpanId={selectedSpanId}
                onSpanSelect={onSpanSelect}
                forceOpen={searching}
              />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
