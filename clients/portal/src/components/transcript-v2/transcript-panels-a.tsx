"use client";

import * as React from "react";
import { ChevronRight, ChevronDown, Wrench, Brain } from "lucide-react";
import type { TranscriptMessage, TranscriptToolCall } from "@/lib/observability/types";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import { CollapsedTextWithMore } from "./CollapsedTextWithMore";

export function LazyJson({ value, maxChars = 4_000 }: { value: unknown; maxChars?: number }) {
  const [open, setOpen] = React.useState(false);
  const pretty = React.useMemo(() => {
    if (!open) return null;
    try {
      const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…` : raw;
    } catch {
      return String(value);
    }
  }, [open, value, maxChars]);

  if (typeof value === "string" && value.length < 120) {
    return <span className="font-mono text-xs">{value}</span>;
  }

  return (
    <div className="space-y-space-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-2xs font-mono uppercase tracking-wider text-[var(--accent)] hover:underline"
      >
        {open ? "Hide JSON" : "Show JSON"}
      </button>
      {open && pretty != null && (
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-[var(--text-secondary)]">
          {pretty}
        </pre>
      )}
    </div>
  );
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-space-2 text-2xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
      {children}
    </div>
  );
}

export type IoViewMode = "formatted" | "json";

/** Formatted ↔ JSON toggle for Input/Output panels (Wave 3 reader). */
export function IoFormatToggle({
  value,
  onChange,
  id,
}: {
  value: IoViewMode;
  onChange: (next: IoViewMode) => void;
  id?: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-space-1 rounded border border-[var(--border-subtle)] p-px"
      role="group"
      aria-label="I/O view format"
      data-testid={id ?? "io-format-toggle"}
    >
      <button
        type="button"
        aria-pressed={value === "formatted"}
        onClick={() => onChange("formatted")}
        className={
          value === "formatted"
            ? "rounded px-space-2 py-space-1 text-2xs font-medium text-[var(--text-primary)] bg-[var(--bg-tertiary)]"
            : "rounded px-space-2 py-space-1 text-2xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        }
      >
        Formatted
      </button>
      <button
        type="button"
        aria-pressed={value === "json"}
        onClick={() => onChange("json")}
        className={
          value === "json"
            ? "rounded px-space-2 py-space-1 text-2xs font-medium text-[var(--text-primary)] bg-[var(--bg-tertiary)]"
            : "rounded px-space-2 py-space-1 text-2xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        }
      >
        JSON
      </button>
    </div>
  );
}

export function ReasoningPanel({ blocks }: { blocks: NonNullable<TR["reasoning"]> }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded border border-[var(--warning)]/30 bg-[var(--warning)]/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-space-2 px-space-2 py-space-2 text-left text-[var(--warning)]"
      >
        <Brain className="h-3 w-3" />
        <span className="text-2xs font-mono uppercase tracking-wider">
          Reasoning ({blocks.length} block{blocks.length === 1 ? "" : "s"})
        </span>
        {open ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>
      {open && (
        <div className="border-t border-[var(--warning)]/30 p-space-2 space-y-space-2 text-xs">
          {blocks.map((b, i) => (
            <div key={i} className="font-mono text-xs text-[var(--text-primary)] whitespace-pre-wrap">
              {b.thought && <span className="text-[var(--warning)]">[thought] </span>}
              {b.text}
              {b.signature && (
                <div className="mt-space-1 font-mono text-3xs text-[var(--text-muted)]">
                  signature: {b.signature.slice(0, 20)}…
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function roleColor(role: string): React.CSSProperties {
  switch (role) {
    case "system":
      return { background: "var(--bg-tertiary)", borderColor: "var(--border-default)" };
    case "user":
      return { background: "var(--bg-secondary)", borderColor: "var(--border-default)" };
    case "assistant":
      return { background: "var(--bg-secondary)", borderColor: "var(--accent)" };
    case "tool":
      return { background: "var(--warning-bg)", borderColor: "var(--warning)" };
    default:
      return {};
  }
}

export function MessagesPanel({ title, messages }: { title: string; messages: TranscriptMessage[] }) {
  const [viewMode, setViewMode] = React.useState<IoViewMode>("formatted");
  return (
    <div data-testid="messages-panel">
      <div className="mb-space-1 flex flex-wrap items-center justify-between gap-space-2">
        <SectionHeader>
          {title} ({messages.length})
        </SectionHeader>
        <IoFormatToggle value={viewMode} onChange={setViewMode} id="io-format-toggle-input" />
      </div>
      {viewMode === "json" ? (
        <div className="overflow-x-auto rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-2 text-2xs">
          <LazyJson value={messages} />
        </div>
      ) : (
        <div className="space-y-space-1">
          {messages.map((m, i) => (
            <div
              key={i}
              className="rounded border px-space-2 py-space-2 text-xs"
              style={roleColor(m.role)}
            >
              <div className="mb-space-1 flex items-center gap-space-2 text-2xs font-mono uppercase tracking-wider">
                <span>{m.role}</span>
                {m.name && <span className="text-[var(--text-muted)]">({m.name})</span>}
              </div>
              <div className="text-[var(--text-primary)]">
                {typeof m.content === "string" ? (
                  <CollapsedTextWithMore text={m.content} />
                ) : (
                  <LazyJson value={m.content} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolCallsList({
  toolCalls,
  orgId,
  traceId,
  spanId,
  agentId,
}: {
  toolCalls: TranscriptToolCall[] | null | undefined;
  orgId?: string;
  traceId: string;
  spanId: string;
  agentId?: string;
}): React.ReactElement | null {
  const [labelState, setLabelState] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submitLabel = React.useCallback(
    async (toolName: string, label: "good" | "bad", args: unknown) => {
      if (!orgId) return;
      setBusy(true);
      try {
        const { api } = await import("@/lib/api");
        await api.labelToolCall(orgId, spanId, {
          trace_id: traceId,
          tool_name: toolName,
          label,
          agent_id: agentId,
          args_summary:
            typeof args === "string" ? args : JSON.stringify(args ?? "").slice(0, 500),
        });
        setLabelState(label);
      } catch {
        setLabelState("error");
      } finally {
        setBusy(false);
      }
    },
    [orgId, spanId, traceId, agentId],
  );

  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div>
      <SectionHeader>{`Tool calls (${toolCalls.length})`}</SectionHeader>
      <div className="space-y-space-1">
        {toolCalls.map((tc, i) => (
          <div
            key={i}
            className="rounded border border-[var(--warning)]/30 bg-[var(--bg-secondary)] px-space-2 py-space-2 text-xs"
          >
            <div className="mb-space-1 flex items-center gap-space-2">
              <Wrench className="h-3 w-3 text-[var(--warning)]" />
              <span className="font-mono">{tc.name}</span>
              {tc.id && (
                <span className="text-2xs text-[var(--text-muted)]">{tc.id.slice(0, 12)}…</span>
              )}
              {orgId && (
                <span className="ml-auto flex items-center gap-space-1">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Label ${tc.name} good`}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-space-2 py-space-1 text-2xs border border-[var(--terminal)] text-[var(--terminal)] hover:bg-[var(--terminal)]/10 disabled:opacity-50"
                    onClick={() => void submitLabel(tc.name, "good", tc.arguments)}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Label ${tc.name} bad`}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-space-2 py-space-1 text-2xs border border-[var(--error)] text-[var(--error)] hover:bg-[var(--error)]/10 disabled:opacity-50"
                    onClick={() => void submitLabel(tc.name, "bad", tc.arguments)}
                  >
                    ✗
                  </button>
                </span>
              )}
            </div>
            {labelState && labelState !== "error" && (
              <p className="text-2xs text-[var(--text-muted)]">Labeled {labelState}</p>
            )}
            {labelState === "error" && (
              <p className="text-2xs text-[var(--error)]">Label failed</p>
            )}
            {tc.arguments !== undefined && (
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-2xs text-[var(--text-secondary)]">
                {typeof tc.arguments === "string" ? (
                  tc.arguments
                ) : (
                  <LazyJson value={tc.arguments ?? null} />
                )}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
