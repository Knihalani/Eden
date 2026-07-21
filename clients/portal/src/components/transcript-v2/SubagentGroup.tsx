"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptRow } from "@/lib/observability/types";
import { CollapsedTextWithMore } from "./CollapsedTextWithMore";
import { SpanKindPill } from "./SpanTypeIcon";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function lastMessagePreview(row: TranscriptRow): string | null {
  const messages = row.request_body?.messages;
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content.trim() : "";
    if (content) return content;
  }
  return null;
}

function responsePreview(row: TranscriptRow): string | null {
  const body = row.response_body;
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.content === "string" && obj.content.trim()) return obj.content.trim();
    if (typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
    try {
      return JSON.stringify(body);
    } catch {
      return null;
    }
  }
  return null;
}

export function SubagentGroup({
  row,
  selectedSpanId,
  onSelect,
  orgId: _orgId,
  traceId: _traceId,
  depth = 0,
  children,
  renderExpandedBody,
}: {
  row: TranscriptRow;
  selectedSpanId: string | null;
  onSelect: (id: string) => void;
  orgId?: string;
  traceId: string;
  depth?: number;
  children: ReactNode;
  renderExpandedBody?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded;
  const selected = selectedSpanId === row.span_id;
  const inPreview = lastMessagePreview(row);
  const outPreview = responsePreview(row);

  return (
    <div
      className="min-w-0"
      style={{ marginLeft: depth * 16 }}
      data-testid="subagent-group"
      data-collapsed={collapsed ? "true" : "false"}
      data-span-id={row.span_id}
    >
      <div
        className={cn(
          "rounded-md border px-space-3 py-space-2 transition-colors",
          !collapsed && "sticky top-0 z-10 bg-[var(--bg-primary)]",
          selected
            ? "border-[var(--accent)] bg-[var(--bg-tertiary)]"
            : "border-transparent hover:border-[var(--border-default)] hover:bg-[var(--bg-secondary)]",
        )}
      >
        <div className="flex items-center gap-space-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse subagent" : "Expand subagent"}
            aria-expanded={expanded}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-space-1 -m-space-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onSelect(row.span_id)}
            aria-pressed={selected}
            aria-label={`Select subagent ${row.name || row.span_id.slice(0, 12)}`}
            className="flex min-w-0 flex-1 items-center gap-space-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <SpanKindPill kind="subagent" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-primary)]">
              {row.name || row.event_type || row.span_id.slice(0, 12)}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-muted)]">
              {formatDuration(row.duration_ms)}
            </span>
          </button>
        </div>
        {collapsed && (inPreview || outPreview) ? (
          <div className="mt-space-1 space-y-space-1 pl-11">
            {inPreview ? (
              <div className="min-w-0">
                <span className="font-mono text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                  In
                </span>
                <CollapsedTextWithMore text={inPreview} previewLines={1} />
              </div>
            ) : null}
            {outPreview ? (
              <div className="min-w-0">
                <span className="font-mono text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                  Out
                </span>
                <CollapsedTextWithMore text={outPreview} previewLines={1} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-space-1 space-y-space-2 px-space-3 pb-space-2">
          {renderExpandedBody}
          {children}
        </div>
      ) : null}
    </div>
  );
}
