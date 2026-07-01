"use client";

/**
 * TranscriptView — Laminar-style LLM message cards.
 *
 * Renders a single LLM call as a vertical stack of message
 * cards: system, user, assistant (with reasoning + tool calls),
 * tool results, nested sub-agent traces.
 *
 * Each message card has:
 *   - Role icon + role name
 *   - Content (markdown-lite: headers, code, lists)
 *   - For assistant: reasoning toggle, tool-call badges
 *   - For tool: arg + result preview
 *
 * The component is purely presentational. The parent fetches
 * the trace data + calls the LLM, and passes a flat list of
 * messages. We do NOT make LLM calls from this component.
 */

import { memo, useState } from "react";
import { cn } from "@/lib/utils";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: "ok" | "error" | "pending";
}

export interface TranscriptMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  timestamp?: string;
  // For sub-agent traces: list of nested TranscriptMessage.
  children?: TranscriptMessage[];
}

export interface TranscriptViewProps {
  messages: TranscriptMessage[];
  className?: string;
  // Optional: max content length before collapsing.
  collapseAtChars?: number;
}

const ROLE_META: Record<TranscriptMessage["role"], { label: string; color: string; icon: string }> = {
  system: { label: "System", color: "var(--text-muted)", icon: "⚙" },
  user: { label: "User", color: "var(--info)", icon: "▶" },
  assistant: { label: "Assistant", color: "var(--accent)", icon: "◆" },
  tool: { label: "Tool", color: "var(--warning)", icon: "🔧" } };

export function TranscriptView({ messages, className, collapseAtChars = 1000 }: TranscriptViewProps) {
  if (messages.length === 0) {
    return (
      <div className={cn("rounded border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]", className)}>
        No messages in this trace.
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {messages.map((m) => (
        <MessageCard key={m.id} message={m} collapseAtChars={collapseAtChars} />
      ))}
    </div>
  );
}

const MessageCard = memo(function MessageCard({ message, collapseAtChars }: { message: TranscriptMessage; collapseAtChars: number }) {
  const [expanded, setExpanded] = useState(false);
  const meta = ROLE_META[message.role];
  const tooLong = message.content.length > collapseAtChars;
  const displayed = tooLong && !expanded
    ? message.content.slice(0, collapseAtChars) + "…"
    : message.content;
  return (
    <div className={cn(
      "rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3",
      message.role === "assistant" && "border-l-2 border-l-[var(--accent)]",
    )}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="text-sm" style={{ color: meta.color }}>{meta.icon}</span>
        <span className="font-mono uppercase tracking-wide text-[10px]" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {message.timestamp && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {message.timestamp}
          </span>
        )}
      </div>
      <pre className={cn(
        "whitespace-pre-wrap break-words font-mono text-sm leading-relaxed",
        "text-[var(--text-primary)]",
      )}>
        {displayed}
      </pre>
      {tooLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-[var(--accent)] hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {message.reasoning && message.role === "assistant" && (
        <details className="mt-2 text-xs text-[var(--text-secondary)]">
          <summary className="cursor-pointer text-[var(--text-muted)]">
            Reasoning ({message.reasoning.length} chars)
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[var(--text-secondary)]">
            {message.reasoning}
          </pre>
        </details>
      )}
      {message.tool_calls && message.tool_calls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {message.tool_calls.map((tc) => (
            <ToolCallBadge key={tc.id} tc={tc} />
          ))}
        </div>
      )}
      {message.children && message.children.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--text-muted)]">
            Sub-agent trace ({message.children.length} steps)
          </summary>
          <div className="ml-2 mt-1 border-l border-[var(--border)] pl-2">
            <TranscriptView messages={message.children} />
          </div>
        </details>
      )}
    </div>
  );
});

const ToolCallBadge = memo(function ToolCallBadge({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <span className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          tc.status === "ok" && "bg-[var(--success)]",
          tc.status === "error" && "bg-[var(--error)]",
          tc.status === "pending" && "bg-[var(--warning)]",
        )} />
        <span className="font-mono text-[var(--text-primary)]">{tc.name}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-2 py-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            Args
          </div>
          <pre className="font-mono text-[var(--text-secondary)]">
            {JSON.stringify(tc.args, null, 2)}
          </pre>
          {tc.result !== undefined && (
            <>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                Result
              </div>
              <pre className="max-h-40 overflow-auto font-mono text-[var(--text-secondary)]">
                {JSON.stringify(tc.result, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});
