"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MetricInline } from "@/components/ui/metric-inline";
import type { TranscriptRow } from "@/lib/observability/types";
import {
  formatCost,
  formatLatency,
  formatTokens,
} from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type Props = {
  rows: TranscriptRow[];
  selectedSpanId?: string;
  onSelectSpan?: (spanId: string) => void;
};

function TreeNode({
  row,
  depth,
  selectedSpanId,
  onSelectSpan,
}: {
  row: TranscriptRow;
  depth: number;
  selectedSpanId?: string;
  onSelectSpan?: (spanId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [ioOpen, setIoOpen] = useState(false);
  const t = useTranslations("traces.tree");
  const hasChildren = Boolean(row.children?.length);
  const selected = row.span_id === selectedSpanId;
  const tokens =
    row.input_tokens != null || row.output_tokens != null
      ? (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
      : null;

  const input =
    row.request_body?.messages
      ?.map((m) => `${m.role}: ${m.content}`)
      .join("\n") ||
    (row.request_body ? JSON.stringify(row.request_body, null, 2) : "");
  const output =
    typeof row.response_body === "string"
      ? row.response_body
      : row.response_body
        ? JSON.stringify(row.response_body, null, 2)
        : "";

  return (
    <div data-span-id={row.span_id}>
      <div
        className={cn(
          "flex items-start gap-1 border-b border-[var(--border-subtle)] py-1.5 pr-2",
          selected && "bg-[var(--bg-tertiary)]",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--text-muted)]"
          disabled={!hasChildren}
          aria-expanded={open}
          onClick={() => hasChildren && setOpen((v) => !v)}
        >
          {hasChildren ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : (
            <span className="inline-block h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            onSelectSpan?.(row.span_id);
            setIoOpen(true);
          }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="truncate text-sm text-[var(--text-primary)]">
              {row.name}
            </span>
            <span className="inline-flex flex-wrap items-center gap-2">
              <MetricInline label="" value={formatLatency(row.duration_ms)} mono />
              <MetricInline label="" value={formatTokens(tokens)} mono />
              <MetricInline label="" value={formatCost(row.cost_usd)} mono />
            </span>
          </div>
        </button>
      </div>
      {selected && ioOpen && (input || output) ? (
        <div
          className="grid gap-2 border-b border-[var(--border-subtle)] px-3 py-2 sm:grid-cols-2"
          style={{ marginLeft: `${depth * 12 + 24}px` }}
        >
          {input ? (
            <div>
              <p className="m-0 mb-1 text-2xs uppercase text-[var(--text-muted)]">
                {t("input")}
              </p>
              <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2 font-mono text-xs">
                {input}
              </pre>
            </div>
          ) : null}
          {output ? (
            <div>
              <p className="m-0 mb-1 text-2xs uppercase text-[var(--text-muted)]">
                {t("output")}
              </p>
              <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2 font-mono text-xs">
                {output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {open && hasChildren
        ? row.children!.map((child) => (
            <TreeNode
              key={child.span_id}
              row={child}
              depth={depth + 1}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
            />
          ))
        : null}
    </div>
  );
}

export function TreeCanvas({ rows, selectedSpanId, onSelectSpan }: Props) {
  const t = useTranslations("traces.tree");

  if (rows.length === 0) {
    return (
      <p className="px-3 py-6 text-sm text-[var(--text-muted)]" data-testid="tree-canvas-empty">
        {t("empty")}
      </p>
    );
  }

  return (
    <div data-testid="tree-canvas" data-mode="tree">
      {rows.map((row) => (
        <TreeNode
          key={row.span_id}
          row={row}
          depth={0}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      ))}
    </div>
  );
}
