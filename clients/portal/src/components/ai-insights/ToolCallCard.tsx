"use client";

/**
 * ToolCallCard — renders one server-side tool call inside the AI
 * Insights chat stream.
 *
 * Three states:
 *   - "running": the assistant just emitted the tool call. We show
 *     a spinner with the tool name and a compact JSON dump of the
 *     input so the user can see what the LLM is asking for.
 *   - "ok": the result landed. We show the name, duration, and a
 *     scrollable, pre-formatted JSON dump of the output.
 *   - "error": red border, error message, no output.
 *
 * The card is intentionally terse — the chat transcript is the main
 * UX, and tool cards are diagnostic breadcrumbs the engineer can
 * skim.
 */

import { useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

export interface ToolCallCardProps {
  /** The Anthropic tool_use id, used as a React key by the parent. */
  id: string;
  /** Tool name as registered in the backend (e.g. "list_jobs"). */
  name: string;
  /** Input the LLM passed to the tool. */
  input?: Record<string, unknown>;
  /** Result returned by the tool, once available. */
  result?: {
    status: "ok" | "error";
    output?: unknown;
    duration_ms?: number;
  };
}

export function ToolCallCard({ id, name, input, result }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isRunning = !result;
  const isError = result?.status === "error";

  return (
    <div
      data-tool-call-id={id}
      className={cn(
        "my-2 rounded-md border bg-[var(--bg-elevated)] font-mono text-xs",
        isError
          ? "border-[var(--error)]/40"
          : "border-[var(--border-subtle)]"
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        )}
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
        ) : isError ? (
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--error)]" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)]" />
        )}
        <Wrench className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        <span className="font-medium text-[var(--text-primary)]">{name}</span>
        {result && typeof result.duration_ms === "number" && (
          <Tag className="ml-auto font-mono text-[10px]">
            {result.duration_ms}ms
          </Tag>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2">
          {input !== undefined && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                input
              </div>
              <pre className="max-h-40 overflow-auto rounded bg-[var(--bg-base)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {safeStringify(input)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                {isError ? "error" : "output"}
              </div>
              <pre
                className={cn(
                  "max-h-60 overflow-auto rounded p-2 text-[11px] leading-relaxed",
                  isError
                    ? "bg-[var(--error)]/10 text-[var(--error)]"
                    : "bg-[var(--bg-base)] text-[var(--text-secondary)]"
                )}
              >
                {isError
                  ? String(result.output ?? "")
                  : safeStringify(result.output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
