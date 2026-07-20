"use client";

/**
 * TranscriptView — Laminar-style chronological trace view.
 *
 * Phase 7.2 (C2): the headline viz feature. Renders a trace as a
 * conversation:
 *   - LLM call rows: provider icon + model + duration + tokens + cost
 *   - Tool call rows: tool name + arguments
 *   - Tool result rows: matched to the prior tool call
 *   - Subagent rows: nested card with the subagent's own transcript
 *   - System/framework rows: collapsed into a "Show N internal spans"
 *     toggle so the user sees the agent's actual work, not the
 *     transport plumbing
 *
 * Each row is expandable inline. The top of the view shows a
 * Honeycomb-style summary card (duration, span count, outcome, cost,
 * tokens, model). The right sidebar shows selected span detail.
 *
 * Inputs: an array of TranscriptRow (chronologically ordered) and
 * the trace's metadata.
 */

import * as React from "react";
import Image from "next/image";
import { ChevronRight, ChevronDown, Wrench, Bot, MessageSquare, Brain, Image as ImageIcon, AlertCircle, CheckCircle2, Clock, Copy } from "lucide-react";
import { isInternalFrameworkSpan } from "@/lib/observability/elide";
import { cn } from "@/lib/utils";
import type { TranscriptRow as TR, TranscriptMessage, TranscriptToolCall, TranscriptToolResult } from "@/lib/observability/types";

/** P16 — pretty-print JSON only after explicit expand (memoized). */
function LazyJson({ value, maxChars = 4_000 }: { value: unknown; maxChars?: number }) {
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

// ── Public entry ────────────────────────────────────────────────────

export interface TranscriptViewProps {
  traceId: string;
  rows: TR[];
  totalDurationMs: number;
  totalCost?: number;
  totalTokens?: { input: number; output: number; total: number };
  model?: string;
  outcome?: "success" | "failure" | "partial" | "timeout" | "crash" | null;
  spanCount: number;
  orgId?: string;
}

export function TranscriptView({
  traceId,
  rows,
  totalDurationMs,
  totalCost,
  totalTokens,
  model,
  outcome,
  spanCount,
  orgId }: TranscriptViewProps) {
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | null>(
    rows[0]?.span_id || null
  );
  const [showInternal, setShowInternal] = React.useState(false);

  const { visibleRows, internalCount } = React.useMemo(() => {
    let count = 0;
    const walk = (rs: TR[]): TR[] => {
      const out: TR[] = [];
      for (const r of rs) {
        if (isInternalFrameworkSpan(r.name) && !showInternal) {
          count++;
          continue;
        }
        const child = r.children ? walk(r.children) : undefined;
        out.push({ ...r, children: child });
      }
      return out;
    };
    const filtered = walk(rows);
    return { visibleRows: filtered, internalCount: count };
  }, [rows, showInternal]);

  const selectedRow = React.useMemo(
    () => findRowBySpanId(visibleRows, selectedSpanId),
    [visibleRows, selectedSpanId]
  );

  const flatSpanIds = React.useMemo(() => flattenSpanIds(visibleRows), [visibleRows]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const down = e.key === "ArrowDown" || e.key === "j";
      const up = e.key === "ArrowUp" || e.key === "k";
      if (!down && !up) return;
      if (flatSpanIds.length === 0) return;
      e.preventDefault();
      const idx = selectedSpanId ? flatSpanIds.indexOf(selectedSpanId) : -1;
      const next = down
        ? flatSpanIds[Math.min(idx + 1, flatSpanIds.length - 1)]
        : flatSpanIds[Math.max(idx - 1, 0)];
      if (next) setSelectedSpanId(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatSpanIds, selectedSpanId]);

  const copyTraceSummary = React.useCallback(async () => {
    const summary = [
      `trace=${traceId}`,
      `spans=${spanCount}`,
      `duration_ms=${totalDurationMs}`,
      outcome ? `outcome=${outcome}` : null,
      model ? `model=${model}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    try {
      await navigator.clipboard.writeText(summary);
    } catch {
      // ignore
    }
  }, [traceId, spanCount, totalDurationMs, outcome, model]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Summary card ── */}
      <SummaryCard
        durationMs={totalDurationMs}
        spanCount={spanCount}
        outcome={outcome}
        model={model}
        totalCost={totalCost}
        totalTokens={totalTokens}
      />

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-4 py-space-2 text-xs gap-space-2">
        <span className="text-[var(--text-muted)]">
          {visibleRows.length} step{visibleRows.length === 1 ? "" : "s"}
          {internalCount > 0
            ? ` · ${internalCount} internal hidden`
            : ""}
        </span>
        <div className="flex items-center gap-space-3">
          {internalCount > 0 && (
            <button
              type="button"
              onClick={() => setShowInternal((v) => !v)}
              className="text-[var(--accent)] hover:underline min-h-[44px] px-space-1"
            >
              {showInternal ? "Hide internal" : "Show internal"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void copyTraceSummary()}
            className="inline-flex items-center gap-space-1 text-[var(--accent)] hover:underline min-h-[44px] px-space-1"
            title="Copy trace summary"
          >
            <Copy className="h-3 w-3" /> Copy summary
          </button>
        </div>
      </div>

      {/* ── Body: transcript + sidebar ── */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {visibleRows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
              No spans to display
            </div>
          ) : (
            <div className="space-y-space-1 p-space-2">
              {visibleRows.map((row) => (
                <TranscriptRowItem
                  key={row.span_id}
                  row={row}
                  selectedSpanId={selectedSpanId}
                  onSelect={setSelectedSpanId}
                  orgId={orgId}
                  traceId={traceId}
                  depth={0}
                />
              ))}
            </div>
          )}
        </div>
        {selectedRow && (
          <SpanDetailSidebar row={selectedRow} orgId={orgId} />
        )}
      </div>
    </div>
  );
}

// ── Summary card ────────────────────────────────────────────────────

function SummaryCard({
  durationMs,
  spanCount,
  outcome,
  model,
  totalCost,
  totalTokens }: {
  durationMs: number;
  spanCount: number;
  outcome?: string | null;
  model?: string;
  totalCost?: number;
  totalTokens?: { input: number; output: number; total: number };
}) {
  const borderColor =
    outcome === "success" ? "var(--terminal)" :
    outcome === "failure" || outcome === "crash" ? "var(--error)" :
    outcome === "partial" || outcome === "timeout" ? "var(--warning)" :
    "var(--border-default)";
  return (
    <div
      className="border-b-2 px-space-4 py-space-3"
      style={{ borderBottomColor: borderColor, background: "var(--bg-secondary)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-space-2">
          <Clock className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span className="font-mono tabular-nums">{formatDuration(durationMs)}</span>
        </div>
        <div className="text-[var(--text-muted)]">
          <span className="font-mono tabular-nums text-[var(--text-primary)]">{spanCount}</span> spans
        </div>
        {model && (
          <div className="text-[var(--text-muted)]">
            <span className="text-[var(--text-primary)] font-mono text-xs">{model}</span>
          </div>
        )}
        {totalTokens && (
          <div className="text-[var(--text-muted)]">
            <span className="font-mono tabular-nums text-[var(--text-primary)]">
              {totalTokens.total.toLocaleString()}
            </span>{" "}
            tokens
            <span className="ml-space-1 text-2xs">
              ({totalTokens.input.toLocaleString()} in / {totalTokens.output.toLocaleString()} out)
            </span>
          </div>
        )}
        {totalCost != null && (
          <div className="text-[var(--text-muted)]">
            <span className="font-mono tabular-nums text-[var(--text-primary)]">
              ${totalCost.toFixed(4)}
            </span>
          </div>
        )}
        {outcome && (
          <div className="flex items-center gap-space-1">
            {outcome === "success" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--terminal)]" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 text-[var(--error)]" />
            )}
            <span
              className="text-xs font-mono uppercase"
              style={{
                color: outcome === "success" ? "var(--terminal)" : "var(--error)" }}
            >
              {outcome}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Single transcript row ──────────────────────────────────────────

function TranscriptRowItem({
  row,
  selectedSpanId,
  onSelect,
  orgId,
  traceId,
  depth }: {
  row: TR;
  selectedSpanId: string | null;
  onSelect: (id: string) => void;
  orgId?: string;
  traceId: string;
  depth: number;
}) {
  const selected = selectedSpanId === row.span_id;
  const [expanded, setExpanded] = React.useState(true);
  const isLlm = !!row.request_body || !!row.response_body || (row.event_type?.includes("chat") ?? false);
  const isTool = (row.event_type?.includes("tool") ?? false) || (row.tool_calls?.length ?? 0) > 0 || (row.tool_results?.length ?? 0) > 0;
  const isSubagent = !!row.is_subagent || (row.children?.length ?? 0) > 0;

  const Icon = isLlm ? MessageSquare : isTool ? Wrench : isSubagent ? Bot : MessageSquare;
  const iconColor =
    row.outcome === "failure" ? "var(--error)" :
    isLlm ? "var(--accent)" :
    isTool ? "var(--warning)" :
    "var(--text-muted)";

  return (
    <div data-span-id={row.span_id}>
      <div
        className={`group flex items-center gap-space-2 rounded-md border px-space-3 py-space-2 transition-colors ${
          selected
            ? "border-[var(--accent)] bg-[var(--bg-tertiary)]"
            : "border-transparent hover:border-[var(--border-default)] hover:bg-[var(--bg-secondary)]"
        }`}
        style={{ marginLeft: depth * 16 }}
      >
        {/* Expand toggle: a real <button>, sibling to the row-select
            button below. Both buttons live inside the row div so
            we never nest <button> inside <button> (invalid HTML
            that browsers silently re-parse — see H2 audit 2026-07-06). */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse details" : "Expand details"}
          aria-expanded={expanded}
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded p-space-1 -m-space-1"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {/* Row-select button: covers the icon + label + metrics
            area. Visually looks like the whole row is clickable,
            but the chevron is a sibling (not nested) so clicks
            route correctly. */}
        <button
          type="button"
          onClick={() => onSelect(row.span_id)}
          aria-pressed={selected}
          aria-label={`Select span ${row.name || row.event_type || row.span_id.slice(0, 12)}`}
          className="flex flex-1 items-center gap-space-2 min-w-0 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] -my-space-1 -mr-space-1 py-space-1 pr-space-1"
        >
          <Icon className="h-3.5 w-3.5" style={{ color: iconColor }} />
          <span className="flex-1 truncate font-mono text-xs">
            {row.name || row.event_type || row.span_id.slice(0, 12)}
          </span>
          <span className="font-mono text-2xs text-[var(--text-muted)] tabular-nums">
            {formatDuration(row.duration_ms)}
          </span>
          {isLlm && row.streaming_metrics?.ttft_ms != null && (
            <span className="font-mono text-2xs text-[var(--terminal)] tabular-nums">
              TTFT {Math.round(row.streaming_metrics.ttft_ms)}ms
            </span>
          )}
          {row.cache_hit && (
            <span className="rounded bg-[var(--terminal)]/20 px-space-1 py-space-1 text-3xs font-mono text-[var(--terminal)]">
              CACHED
            </span>
          )}
          {row.outcome === "failure" && (
            <AlertCircle className="h-3 w-3 text-[var(--error)]" />
          )}
        </button>
      </div>

      {expanded && (
        <div className="ml-7 mt-space-1 space-y-space-2 px-space-3 pb-space-2">
          {/* Reasoning */}
          {row.reasoning && row.reasoning.length > 0 && (
            <ReasoningPanel blocks={row.reasoning} />
          )}

          {/* Request messages */}
          {row.request_body?.messages && row.request_body.messages.length > 0 && (
            <MessagesPanel
              title="Request"
              messages={row.request_body.messages}
            />
          )}

          {/* System prompt (if separate from messages) */}
          {row.request_body?.system != null && row.request_body.system !== "" ? (
            <div>
              <SectionHeader>System</SectionHeader>
              <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-2 text-xs">
                {typeof row.request_body.system === "string"
                  ? row.request_body.system
                  : <LazyJson value={row.request_body.system} />}
              </div>
            </div>
          ) : null}

          {/* Render the tool-calls list. Now that the parent's
              ``response_body`` narrowing uses a ternary with
              ``typeof`` (not ``&&``), the ``unknown`` leak is
              gone and this ``&&`` short-circuit type-checks
              cleanly: the result is
              ``TranscriptToolCall[] | null | undefined | boolean
              | JSX.Element``, all of which are valid
              ``ReactNode``s. */}
          {row.tool_calls && row.tool_calls.length > 0 && (
            <ToolCallsList
              toolCalls={row.tool_calls}
              orgId={orgId}
              traceId={traceId}
              spanId={row.span_id}
              agentId={row.agent_id ?? undefined}
            />
          )}

          {/* Tool results */}
          {row.tool_results && row.tool_results.length > 0 && (
            <ToolResultsPanel results={row.tool_results} />
          )}

          {/* Images */}
          {row.images && row.images.length > 0 && (
            <ImagesPanel images={row.images} orgId={orgId} />
          )}

          {/* Always show response when present — request messages must not
              hide the assistant output (primary reason people open traces). */}
          {typeof row.response_body !== "undefined" && row.response_body != null ? (
            <ResponsePanel response={row.response_body as never} />
          ) : null}

          {/* Citations */}
          {row.citations && row.citations.length > 0 && (
            <CitationsPanel citations={row.citations} />
          )}

          {/* Logprobs */}
          {row.logprobs?.content && row.logprobs.content.length > 0 && (
            <LogprobsPanel entries={row.logprobs.content} />
          )}
        </div>
      )}

      {/* Children (subagent nesting) */}
      {expanded && row.children && row.children.length > 0 && (
        <div className="mt-space-1 space-y-space-1">
          {row.children.map((c) => (
            <TranscriptRowItem
              key={c.span_id}
              row={c}
              selectedSpanId={selectedSpanId}
              onSelect={onSelect}
              orgId={orgId}
              traceId={traceId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-panels ──────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-space-2 text-2xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
      {children}
    </div>
  );
}

function ReasoningPanel({ blocks }: { blocks: NonNullable<TR["reasoning"]> }) {
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

function MessagesPanel({ title, messages }: { title: string; messages: TranscriptMessage[] }) {
  return (
    <div>
      <SectionHeader>{title} ({messages.length})</SectionHeader>
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
            <div className="whitespace-pre-wrap text-[var(--text-primary)]">
              {typeof m.content === "string" ? m.content : <LazyJson value={m.content} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function roleColor(role: string): React.CSSProperties {
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

function ToolCallsList({
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
          <div key={i} className="rounded border border-[var(--warning)]/30 bg-[var(--bg-secondary)] px-space-2 py-space-2 text-xs">
            <div className="mb-space-1 flex items-center gap-space-2">
              <Wrench className="h-3 w-3 text-[var(--warning)]" />
              <span className="font-mono">{tc.name}</span>
              {tc.id && <span className="text-2xs text-[var(--text-muted)]">{tc.id.slice(0, 12)}…</span>}
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
                {typeof tc.arguments === "string" ? tc.arguments : <LazyJson value={tc.arguments ?? null} />}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolResultsPanel({ results }: { results: TranscriptToolResult[] }) {
  return (
    <div>
      <SectionHeader>Tool results ({results.length})</SectionHeader>
      <div className="space-y-space-1">
        {results.map((tr, i) => (
          <div
            key={i}
            className={cn(
              "rounded border px-space-2 py-space-2 text-xs",
              tr.is_error
                ? "bg-[var(--error-dim)] border-[var(--error)]"
                : "bg-[var(--bg-secondary)] border-[var(--border-default)]"
            )}
          >
            {tr.is_error && (
              <div className="mb-space-1 flex items-center gap-space-1 text-2xs font-mono uppercase text-[var(--error)]">
                <AlertCircle className="h-3 w-3" /> Error
              </div>
            )}
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-2xs text-[var(--text-secondary)]">
              {typeof tr.content === "string" ? tr.content : <LazyJson value={tr.content ?? null} />}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImagesPanel({ images }: { images: NonNullable<TR["images"]>; orgId?: string }) {
  return (
    <div>
      <SectionHeader>Images ({images.length})</SectionHeader>
      <div className="flex flex-wrap gap-space-2">
        {images.map((img, i) => (
          <div
            key={i}
            className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-1"
          >
            {img.url ? (
              <Image
                src={img.url}
                alt={img.content_type?.startsWith("image/") ? "transcript image" : img.content_type || "transcript image"}
                width={128}
                height={128}
                unoptimized
                className="h-32 w-32 rounded object-cover"
              />
            ) : (
              <div className="flex h-32 w-32 flex-col items-center justify-center text-2xs text-[var(--text-muted)]">
                <ImageIcon className="mb-space-1 h-5 w-5" />
                <span>{img.content_type || "image"}</span>
                {img.source && <span>{img.source}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function extractResponseText(response: unknown): string | null {
  if (response == null) return null;
  if (typeof response === "string") return response;
  if (typeof response !== "object") return String(response);
  const obj = response as Record<string, unknown>;
  // OpenAI chat completion shape
  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const msg = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof msg?.content === "string" && msg.content.trim()) return msg.content;
  }
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
  if (typeof obj.output === "string" && obj.output.trim()) return obj.output;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  return null;
}

function ResponsePanel({ response }: { response: unknown }) {
  const text = extractResponseText(response);
  return (
    <div>
      <SectionHeader>Response</SectionHeader>
      {text ? (
        <div className="whitespace-pre-wrap rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-2 text-xs text-[var(--text-primary)] leading-relaxed">
          {text}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-2 text-2xs">
          <LazyJson value={response} />
        </div>
      )}
    </div>
  );
}

function CitationsPanel({ citations }: { citations: NonNullable<TR["citations"]> }) {
  return (
    <div>
      <SectionHeader>Citations ({citations.length})</SectionHeader>
      <ol className="space-y-space-1 text-xs">
        {citations.map((c, i) => (
          <li key={i} className="flex gap-space-2">
            <span className="text-[var(--text-muted)]">{i + 1}.</span>
            <div>
              {c.url ? (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  {c.title || c.url}
                </a>
              ) : (
                <span>{c.title || "(no url)"}</span>
              )}
              {c.cited_text && (
                <div className="text-2xs text-[var(--text-muted)] italic">
                  &ldquo;{c.cited_text}&rdquo;
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LogprobsPanel({ entries }: { entries: NonNullable<NonNullable<TR["logprobs"]>["content"]> }) {
  return (
    <div>
      <SectionHeader>Top logprobs ({entries.length})</SectionHeader>
      <table className="w-full text-2xs font-mono">
        <thead className="text-[var(--text-muted)]">
          <tr>
            <th className="text-left">Token</th>
            <th className="text-right">Logprob</th>
            <th className="text-right">Bytes</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} className="border-t border-[var(--border-default)]">
              <td className="text-[var(--text-primary)]">{e.token}</td>
              <td className="text-right tabular-nums">{e.logprob.toFixed(4)}</td>
              <td className="text-right text-[var(--text-muted)]">
                {e.bytes ? `[${e.bytes.slice(0, 6).join(",")}…]` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────

function SpanDetailSidebar({ row }: { row: TR; orgId?: string }) {
  return (
    <aside
      className="w-80 shrink-0 border-l border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-y-auto"
    >
      <div className="border-b border-[var(--border-default)] px-space-3 py-space-2">
        <div className="text-2xs font-mono uppercase tracking-wider text-[var(--text-muted)]">Span</div>
        <div className="truncate font-mono text-sm">{row.name}</div>
        <div className="mt-space-1 text-2xs text-[var(--text-muted)]">
          {row.span_id} • {row.event_type}
        </div>
      </div>
      <div className="space-y-space-2 p-space-3 text-xs">
        <KV k="duration" v={formatDuration(row.duration_ms)} />
        <KV k="outcome" v={row.outcome || "—"} />
        {row.finish_reason && <KV k="finish_reason" v={row.finish_reason} />}
        {row.system_fingerprint && <KV k="fingerprint" v={row.system_fingerprint} />}
        {row.model_version && <KV k="model_version" v={row.model_version} />}
        {row.service_tier && <KV k="service_tier" v={row.service_tier} />}
        {row.cache_hit && <KV k="cache" v="HIT" />}
        {row.streaming_metrics?.ttft_ms != null && (
          <KV k="ttft_ms" v={row.streaming_metrics.ttft_ms.toFixed(0)} />
        )}
        {row.streaming_metrics?.itl_ms_avg != null && (
          <KV k="itl_ms_avg" v={row.streaming_metrics.itl_ms_avg.toFixed(1)} />
        )}
        {row.streaming_metrics?.tpot_ms != null && (
          <KV k="tpot_ms" v={row.streaming_metrics.tpot_ms.toFixed(1)} />
        )}
        <KV k="timestamp" v={row.timestamp} />
      </div>
    </aside>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-space-2 text-xs">
      <span className="text-[var(--text-muted)] font-mono">{k}</span>
      <span className="font-mono text-[var(--text-primary)] text-right truncate">{v}</span>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function findRowBySpanId(rows: TR[], id: string | null): TR | null {
  if (!id) return null;
  for (const r of rows) {
    if (r.span_id === id) return r;
    if (r.children) {
      const found = findRowBySpanId(r.children, id);
      if (found) return found;
    }
  }
  return null;
}

function flattenSpanIds(rows: TR[]): string[] {
  const out: string[] = [];
  const walk = (rs: TR[]) => {
    for (const r of rs) {
      if (r.span_id) out.push(r.span_id);
      if (r.children?.length) walk(r.children);
    }
  };
  walk(rows);
  return out;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
