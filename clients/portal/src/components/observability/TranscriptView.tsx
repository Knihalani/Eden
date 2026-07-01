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
import { ChevronRight, ChevronDown, Wrench, Bot, MessageSquare, Brain, Image as ImageIcon, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { isInternalFrameworkSpan } from "@/lib/observability/elide";
import type { TranscriptRow as TR, TranscriptMessage, TranscriptToolCall, TranscriptToolResult } from "@/lib/observability/types";

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
      {internalCount > 0 && (
        <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-2 text-xs">
          <span className="text-[var(--text-muted)]">
            {internalCount} framework-internal span{internalCount === 1 ? "" : "s"} hidden
          </span>
          <button
            onClick={() => setShowInternal((v) => !v)}
            className="text-[var(--accent)] hover:underline"
          >
            {showInternal ? "Hide" : "Show"}
          </button>
        </div>
      )}

      {/* ── Body: transcript + sidebar ── */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {visibleRows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
              No spans to display
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {visibleRows.map((row) => (
                <TranscriptRowItem
                  key={row.span_id}
                  row={row}
                  selected={selectedSpanId === row.span_id}
                  onSelect={setSelectedSpanId}
                  orgId={orgId}
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
      className="border-b-2 px-4 py-3"
      style={{ borderBottomColor: borderColor, background: "var(--bg-secondary)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-1.5">
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
            <span className="ml-1 text-[10px]">
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
          <div className="flex items-center gap-1">
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
  selected,
  onSelect,
  orgId,
  depth }: {
  row: TR;
  selected: boolean;
  onSelect: (id: string) => void;
  orgId?: string;
  depth: number;
}) {
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
    <div>
      <button
        onClick={() => onSelect(row.span_id)}
        className={`group w-full text-left rounded-md border transition-colors ${
          selected
            ? "border-[var(--accent)] bg-[var(--bg-tertiary)]"
            : "border-transparent hover:border-[var(--border-default)] hover:bg-[var(--bg-secondary)]"
        }`}
        style={{ marginLeft: depth * 16 }}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="text-[var(--text-muted)]"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
          <Icon className="h-3.5 w-3.5" style={{ color: iconColor }} />
          <span className="flex-1 truncate font-mono text-xs">
            {row.name || row.event_type || row.span_id.slice(0, 12)}
          </span>
          <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
            {formatDuration(row.duration_ms)}
          </span>
          {isLlm && row.streaming_metrics?.ttft_ms != null && (
            <span className="font-mono text-[10px] text-[var(--terminal)] tabular-nums">
              TTFT {Math.round(row.streaming_metrics.ttft_ms)}ms
            </span>
          )}
          {row.cache_hit && (
            <span className="rounded bg-[var(--terminal)]/20 px-1 py-0.5 text-[9px] font-mono text-[var(--terminal)]">
              CACHED
            </span>
          )}
          {row.outcome === "failure" && (
            <AlertCircle className="h-3 w-3 text-[var(--error)]" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="ml-7 mt-1 space-y-2 px-3 pb-2">
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
              <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs">
                {typeof row.request_body.system === "string"
                  ? row.request_body.system
                  : <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify(row.request_body.system, null, 2)}</pre>}
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
            <ToolCallsList toolCalls={row.tool_calls} />
          )}

          {/* Tool results */}
          {row.tool_results && row.tool_results.length > 0 && (
            <ToolResultsPanel results={row.tool_results} />
          )}

          {/* Images */}
          {row.images && row.images.length > 0 && (
            <ImagesPanel images={row.images} orgId={orgId} />
          )}

          {/* Response content (when no structured messages).
              NOTE: ``row.response_body`` is typed as ``unknown``,
              so a ``&&`` short-circuit here would leak ``unknown``
              into the JSX children union and trigger TS2322 on
              every sibling. The ternary + ``typeof`` narrowing
              keeps the result type a clean
              ``JSX.Element | null``. */}
          {typeof row.response_body !== "undefined" && !row.request_body?.messages ? (
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
        <div className="mt-1 space-y-1">
          {row.children.map((c) => (
            <TranscriptRowItem
              key={c.span_id}
              row={c}
              selected={selected}
              onSelect={onSelect}
              orgId={orgId}
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
    <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
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
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[var(--warning)]"
      >
        <Brain className="h-3 w-3" />
        <span className="text-[10px] font-mono uppercase tracking-wider">
          Reasoning ({blocks.length} block{blocks.length === 1 ? "" : "s"})
        </span>
        {open ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>
      {open && (
        <div className="border-t border-[var(--warning)]/30 p-2 space-y-2 text-xs">
          {blocks.map((b, i) => (
            <div key={i} className="font-mono text-[11px] text-[var(--text-primary)] whitespace-pre-wrap">
              {b.thought && <span className="text-[var(--warning)]">[thought] </span>}
              {b.text}
              {b.signature && (
                <div className="mt-1 text-[9px] text-[var(--text-muted)]">
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
      <div className="space-y-1">
        {messages.map((m, i) => (
          <div
            key={i}
            className="rounded border px-2 py-1.5 text-xs"
            style={roleColor(m.role)}
          >
            <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider">
              <span>{m.role}</span>
              {m.name && <span className="text-[var(--text-muted)]">({m.name})</span>}
            </div>
            <div className="whitespace-pre-wrap text-[var(--text-primary)]">
              {typeof m.content === "string" ? m.content : <pre className="overflow-x-auto font-mono text-[11px]">{JSON.stringify(m.content, null, 2)}</pre>}
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

function __ToolCallsSection({ calls }: { calls: TranscriptToolCall[] | null | undefined }): React.ReactElement | null {
  if (!calls || calls.length === 0) return null;
  return <ToolCallsList toolCalls={calls} />;
}

function ToolCallsList({ toolCalls }: { toolCalls: TranscriptToolCall[] | null | undefined }): React.ReactElement | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div>
      <SectionHeader>{`Tool calls (${toolCalls.length})`}</SectionHeader>
      <div className="space-y-1">
        {toolCalls.map((tc, i) => (
          <div key={i} className="rounded border border-[var(--warning)]/30 bg-[var(--bg-secondary)] px-2 py-1.5 text-xs">
            <div className="mb-0.5 flex items-center gap-1.5">
              <Wrench className="h-3 w-3 text-[var(--warning)]" />
              <span className="font-mono">{tc.name}</span>
              {tc.id && <span className="text-[10px] text-[var(--text-muted)]">{tc.id.slice(0, 12)}…</span>}
            </div>
            {tc.arguments !== undefined && (
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-[var(--text-secondary)]">
                {typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? null, null, 2)}
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
      <div className="space-y-1">
        {results.map((tr, i) => (
          <div
            key={i}
            className="rounded border px-2 py-1.5 text-xs"
            style={{
              background: tr.is_error ? "var(--error)/10" : "var(--bg-secondary)",
              borderColor: tr.is_error ? "var(--error)" : "var(--border-default)" }}
          >
            {tr.is_error && (
              <div className="mb-0.5 flex items-center gap-1 text-[10px] font-mono uppercase text-[var(--error)]">
                <AlertCircle className="h-3 w-3" /> Error
              </div>
            )}
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-[var(--text-secondary)]">
              {typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? null, null, 2)}
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
      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => (
          <div
            key={i}
            className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
          >
            {img.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={img.url}
                alt={img.content_type?.startsWith("image/") ? "transcript image" : img.content_type || "transcript image"}
                width={128}
                height={128}
                loading="lazy"
                decoding="async"
                className="h-32 w-32 rounded object-cover"
              />
            ) : (
              <div className="flex h-32 w-32 flex-col items-center justify-center text-[10px] text-[var(--text-muted)]">
                <ImageIcon className="mb-1 h-5 w-5" />
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

function ResponsePanel({ response }: { response: unknown }) {
  return (
    <div>
      <SectionHeader>Response</SectionHeader>
      <pre className="overflow-x-auto rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-2 text-[10px] font-mono text-[var(--text-secondary)]">
        {JSON.stringify(response, null, 2)}
      </pre>
    </div>
  );
}

function CitationsPanel({ citations }: { citations: NonNullable<TR["citations"]> }) {
  return (
    <div>
      <SectionHeader>Citations ({citations.length})</SectionHeader>
      <ol className="space-y-1 text-xs">
        {citations.map((c, i) => (
          <li key={i} className="flex gap-2">
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
                <div className="text-[10px] text-[var(--text-muted)] italic">
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
      <table className="w-full text-[10px] font-mono">
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
      <div className="border-b border-[var(--border-default)] px-3 py-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">Span</div>
        <div className="truncate font-mono text-sm">{row.name}</div>
        <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
          {row.span_id} • {row.event_type}
        </div>
      </div>
      <div className="space-y-2 p-3 text-xs">
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
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
