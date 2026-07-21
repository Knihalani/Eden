"use client";

import { useState } from "react";
import {
  Box,
  Brain,
  ChevronDown,
  ChevronRight,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, type Span } from "./inspector-helpers";

const SPAN_ICONS: Record<Span["span_type"], typeof Brain> = {
  llm_completion: Brain,
  tool_invocation: Wrench,
  env_step: Box,
  reasoning: Brain,
  user_interaction: Brain,
  system: Box,
};

export function SpanNode({
  span,
  depth,
  query,
}: {
  span: Span;
  depth: number;
  query: string;
}) {
  const [open, setOpen] = useState(depth < 2);
  const matchesQuery =
    !query ||
    span.name.toLowerCase().includes(query.toLowerCase()) ||
    JSON.stringify(span.payload).toLowerCase().includes(query.toLowerCase());
  if (!matchesQuery && depth > 0) return null;

  const Icon = SPAN_ICONS[span.span_type] ?? Box;

  return (
    <div className="font-mono text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
          "hover:bg-[var(--bg-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]",
          depth === 0 && "bg-[var(--bg-tertiary)]",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        )}
        <Icon className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        <span className="flex-1 truncate text-[var(--text-primary)]">
          {span.name}
        </span>
        <span className="shrink-0 text-[var(--text-muted)]">
          {formatDuration(span.duration_ms)}
        </span>
      </button>
      {open && (
        <pre className="ml-8 mr-2 mb-2 overflow-x-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {JSON.stringify(span.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
