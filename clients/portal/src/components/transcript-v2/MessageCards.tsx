"use client";

/**
 * MessageCards — LLM message stack (formerly transcript-view twin).
 * Canonical message-card surface under transcript-v2; inspector imports this.
 * F21: tool rows expose ✓/✗ label buttons when orgId + traceId provided.
 */

import { memo, useCallback, useState } from "react";
import { cn } from "@/lib/utils";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: "ok" | "error" | "pending";
  span_id?: string;
}

export interface TranscriptMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  timestamp?: string;
  children?: TranscriptMessage[];
  span_id?: string;
}

export interface MessageCardsProps {
  messages: TranscriptMessage[];
  className?: string;
  collapseAtChars?: number;
  orgId?: string;
  traceId?: string;
  agentId?: string;
}

const ROLE_META: Record<
  TranscriptMessage["role"],
  { label: string; color: string; icon: string }
> = {
  system: { label: "System", color: "var(--text-muted)", icon: "⚙" },
  user: { label: "User", color: "var(--info)", icon: "▶" },
  assistant: { label: "Assistant", color: "var(--accent)", icon: "◆" },
  tool: { label: "Tool", color: "var(--warning)", icon: "🔧" },
};

export function MessageCards({
  messages,
  className,
  collapseAtChars = 1000,
  orgId,
  traceId,
  agentId,
}: MessageCardsProps) {
  if (messages.length === 0) {
    return (
      <div
        className={cn(
          "rounded border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]",
          className,
        )}
      >
        No messages in this trace.
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-space-2", className)} data-testid="message-cards">
      {messages.map((m) => (
        <MessageCard
          key={m.id}
          message={m}
          collapseAtChars={collapseAtChars}
          orgId={orgId}
          traceId={traceId}
          agentId={agentId}
        />
      ))}
    </div>
  );
}

/** @deprecated Prefer MessageCards — kept for inspector import path. */
export const TranscriptView = MessageCards;
export type TranscriptViewProps = MessageCardsProps;

/** Laminar message clamp — max height before expand strip. */
export const MESSAGE_CARD_MAX_PX = 360;

const MessageCard = memo(function MessageCard({
  message,
  collapseAtChars,
  orgId,
  traceId,
  agentId,
  nested = false,
}: {
  message: TranscriptMessage;
  collapseAtChars: number;
  orgId?: string;
  traceId?: string;
  agentId?: string;
  /** Nested children use hairline separators — no card-in-card. */
  nested?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = ROLE_META[message.role];
  const tooLong = message.content.length > collapseAtChars;
  const displayed =
    tooLong && !expanded ? message.content.slice(0, collapseAtChars) + "…" : message.content;

  return (
    <div
      className={
        nested
          ? "space-y-space-1 py-space-2"
          : "rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-3"
      }
      data-testid="message-card"
    >
      <div className="mb-space-1 flex items-center gap-space-2 text-xs font-medium" style={{ color: meta.color }}>
        <span aria-hidden>{meta.icon}</span>
        {meta.label}
      </div>
      <div
        className={cn(
          "relative",
          !expanded && "max-h-[360px] overflow-hidden",
        )}
        data-message-clamp={MESSAGE_CARD_MAX_PX}
      >
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-[var(--text-secondary)]">
          {displayed}
        </pre>
        {!expanded && (tooLong || message.content.length > 400) ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-[var(--bg-primary)] to-transparent"
            data-testid="message-card-expand-strip"
          >
            <button
              type="button"
              className="pointer-events-auto mb-space-1 min-h-8 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 text-xs text-[var(--accent)] hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
            >
              Expand
            </button>
          </div>
        ) : null}
      </div>
      {expanded && (tooLong || message.content.length > 400) ? (
        <button
          type="button"
          className="mt-space-1 text-xs text-[var(--accent)] hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(false);
          }}
        >
          Collapse
        </button>
      ) : null}
      {message.tool_calls && message.tool_calls.length > 0 && (
        <ToolLabelRow
          toolCalls={message.tool_calls}
          orgId={orgId}
          traceId={traceId}
          agentId={agentId}
          fallbackSpanId={message.span_id ?? message.id}
        />
      )}
      {message.role === "tool" && orgId && traceId && (
        <ToolLabelRow
          toolCalls={[
            {
              id: message.tool_call_id ?? message.id,
              name: message.content.slice(0, 64) || "tool",
              args: {},
              status: "ok",
              span_id: message.span_id ?? message.id,
            },
          ]}
          orgId={orgId}
          traceId={traceId}
          agentId={agentId}
          fallbackSpanId={message.span_id ?? message.id}
        />
      )}
      {message.children && message.children.length > 0 && (
        <div className="mt-space-2 ml-space-3 space-y-space-2 border-l border-[var(--border-subtle)] pl-space-3">
          {message.children.map((child) => (
            <MessageCard
              key={child.id}
              message={child}
              collapseAtChars={collapseAtChars}
              orgId={orgId}
              traceId={traceId}
              agentId={agentId}
              nested
            />
          ))}
        </div>
      )}
    </div>
  );
});

function ToolLabelRow({
  toolCalls,
  orgId,
  traceId,
  agentId,
  fallbackSpanId,
}: {
  toolCalls: ToolCall[];
  orgId?: string;
  traceId?: string;
  agentId?: string;
  fallbackSpanId: string;
}) {
  const [labelState, setLabelState] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (tc: ToolCall, label: "good" | "bad") => {
      if (!orgId || !traceId) return;
      const spanId = tc.span_id || tc.id || fallbackSpanId;
      setBusy(true);
      try {
        const { api } = await import("@/lib/api");
        await api.labelToolCall(orgId, spanId, {
          trace_id: traceId,
          tool_name: tc.name,
          label,
          agent_id: agentId,
          args_summary: JSON.stringify(tc.args ?? {}).slice(0, 500),
        });
        setLabelState((s) => ({ ...s, [spanId]: label }));
      } catch {
        setLabelState((s) => ({ ...s, [spanId]: "error" }));
      } finally {
        setBusy(false);
      }
    },
    [orgId, traceId, agentId, fallbackSpanId],
  );

  if (!orgId || !traceId) return null;

  return (
    <ul className="mt-space-2 space-y-space-1" data-testid="f21-tool-labels">
      {toolCalls.map((tc) => {
        const spanId = tc.span_id || tc.id || fallbackSpanId;
        const state = labelState[spanId];
        return (
          <li
            key={spanId}
            className="flex items-center gap-space-2 rounded border border-[var(--border-subtle)] px-space-2 py-space-1 text-xs"
          >
            <span className="font-mono truncate">{tc.name}</span>
            <span className="ml-auto flex items-center gap-space-1">
              {state === "good" || state === "bad" ? (
                <span className="text-[var(--text-muted)]">labeled {state}</span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Label ${tc.name} good`}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-space-2 py-space-1 border border-[var(--terminal)] text-[var(--terminal)] disabled:opacity-50"
                    onClick={() => void submit(tc, "good")}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Label ${tc.name} bad`}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-space-2 py-space-1 border border-[var(--error)] text-[var(--error)] disabled:opacity-50"
                    onClick={() => void submit(tc, "bad")}
                  >
                    ✗
                  </button>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
