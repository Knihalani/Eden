"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import { classifySpanKind, spanKindLabel } from "@/components/transcript-v2/span-kind";
import { SpanKindPill } from "@/components/transcript-v2/SpanTypeIcon";
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

function oneLinePreview(row: TR): string | null {
  const kind = classifySpanKind(row);
  if (row.outcome === "failure" || row.outcome === "error" || kind === "error") {
    return "error";
  }
  if (kind === "tool" && row.tool_calls?.[0]?.name) return row.tool_calls[0].name;
  if (typeof row.response_body === "string" && row.response_body.trim()) {
    return row.response_body.trim().slice(0, 100);
  }
  if (row.request_body?.messages?.length) {
    const last = row.request_body.messages[row.request_body.messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : "";
    if (content) return content.slice(0, 100);
  }
  if (row.tool_results?.[0]) {
    const c = row.tool_results[0].content;
    if (typeof c === "string") return c.slice(0, 100);
  }
  return null;
}

export interface TranscriptStepRowProps {
  row: TR;
  selected: boolean;
  depth?: number;
  collapsed?: boolean;
  childCount?: number;
  onSelect: () => void;
  onToggleCollapse?: () => void;
}

/** Flat chronological step row — kind · name · preview · duration/tokens/$ · selection. */
export function TranscriptStepRow({
  row,
  selected,
  depth = 0,
  collapsed,
  childCount = 0,
  onSelect,
  onToggleCollapse,
}: TranscriptStepRowProps) {
  const kind = classifySpanKind(row);
  const preview = oneLinePreview(row);
  const tokens =
    row.input_tokens != null || row.output_tokens != null
      ? `${formatTokens(row.input_tokens ?? 0) ?? "0"}→${formatTokens(row.output_tokens ?? 0) ?? "0"}`
      : null;
  const cost = formatCostUsd(row.cost_usd ?? null);
  const failed =
    row.outcome === "failure" ||
    row.outcome === "error" ||
    row.outcome === "crash" ||
    row.outcome === "timeout";

  return (
    <div
      role="option"
      aria-selected={selected}
      data-span-id={row.span_id}
      data-testid="transcript-step-row"
      data-kind={kind}
      className={cn(
        "group flex cursor-pointer items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-xs hover:bg-[var(--bg-secondary)]",
        selected && "bg-[var(--bg-secondary)] ring-1 ring-inset ring-[var(--border-default)]",
        failed && "border-l-2 border-l-[var(--error)]",
      )}
      style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
    >
      {childCount > 0 && onToggleCollapse ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand subagent" : "Collapse subagent"}
          className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse();
          }}
        >
          <ChevronRight
            className={cn("h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")}
          />
        </button>
      ) : (
        <span className="inline-block w-3.5 shrink-0" aria-hidden />
      )}

      <SpanKindPill kind={kind} className="shrink-0" />
      <span className="sr-only">{spanKindLabel(kind)}</span>

      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[var(--text-primary)]" title={row.name}>
          {row.name}
        </div>
        {preview ? (
          <div
            className="truncate text-2xs text-[var(--text-muted)]"
            data-testid="transcript-step-preview"
          >
            {preview}
          </div>
        ) : null}
        {collapsed && childCount > 0 ? (
          <div className="text-2xs text-[var(--text-muted)]">
            {childCount} nested span{childCount === 1 ? "" : "s"}
          </div>
        ) : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2 font-mono tabular-nums text-[var(--text-muted)]">
        <span>{formatDuration(row.duration_ms)}</span>
        {tokens ? <span className="hidden sm:inline">{tokens}</span> : null}
        {cost ? <span className="hidden md:inline">{cost}</span> : null}
      </div>
    </div>
  );
}
