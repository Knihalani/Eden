"use client";

import * as React from "react";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import { classifySpanKind } from "./span-kind";
import { SpanKindPill } from "./SpanTypeIcon";
import { SubagentGroup } from "./SubagentGroup";
import { formatDuration } from "./transcript-format";
import {
  LazyJson,
  SectionHeader,
  ReasoningPanel,
  MessagesPanel,
  ToolCallsList,
  ToolResultsPanel,
  ImagesPanel,
  ResponsePanel,
  CitationsPanel,
  LogprobsPanel,
} from "./transcript-panels";

function RowExpandedPanels({
  row,
  orgId,
  traceId,
}: {
  row: TR;
  orgId?: string;
  traceId: string;
}) {
  return (
    <>
      {row.reasoning && row.reasoning.length > 0 && <ReasoningPanel blocks={row.reasoning} />}

      {row.request_body?.messages && row.request_body.messages.length > 0 && (
        <MessagesPanel title="Request" messages={row.request_body.messages} />
      )}

      {row.request_body?.system != null && row.request_body.system !== "" ? (
        <div>
          <SectionHeader>System</SectionHeader>
          <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-2 text-xs">
            {typeof row.request_body.system === "string" ? (
              row.request_body.system
            ) : (
              <LazyJson value={row.request_body.system} />
            )}
          </div>
        </div>
      ) : null}

      {row.tool_calls && row.tool_calls.length > 0 && (
        <ToolCallsList
          toolCalls={row.tool_calls}
          orgId={orgId}
          traceId={traceId}
          spanId={row.span_id}
          agentId={row.agent_id ?? undefined}
        />
      )}

      {row.tool_results && row.tool_results.length > 0 && (
        <ToolResultsPanel results={row.tool_results} />
      )}

      {row.images && row.images.length > 0 && <ImagesPanel images={row.images} orgId={orgId} />}

      {typeof row.response_body !== "undefined" && row.response_body != null ? (
        <ResponsePanel response={row.response_body as never} />
      ) : null}

      {row.citations && row.citations.length > 0 && <CitationsPanel citations={row.citations} />}

      {row.logprobs?.content && row.logprobs.content.length > 0 && (
        <LogprobsPanel entries={row.logprobs.content} />
      )}
    </>
  );
}

export function TranscriptRowItem({
  row,
  selectedSpanId,
  onSelect,
  orgId,
  traceId,
  depth,
}: {
  row: TR;
  selectedSpanId: string | null;
  onSelect: (id: string) => void;
  orgId?: string;
  traceId: string;
  depth: number;
}) {
  const kind = classifySpanKind(row);
  const isSubagent =
    kind === "subagent" ||
    !!row.is_subagent ||
    (row.children?.length ?? 0) > 0;
  const selected = selectedSpanId === row.span_id;
  const [expanded, setExpanded] = React.useState(true);

  const inlinePreview = (() => {
    if (row.outcome === "failure" || row.outcome === "error" || kind === "error") {
      return "error";
    }
    if (kind === "tool" && row.tool_calls?.[0]?.name) return row.tool_calls[0].name;
    if (typeof row.response_body === "string" && row.response_body.trim()) {
      return row.response_body.trim().slice(0, 80);
    }
    if (row.request_body?.messages?.length) {
      const last = row.request_body.messages[row.request_body.messages.length - 1];
      const content = typeof last?.content === "string" ? last.content : "";
      if (content) return content.slice(0, 80);
    }
    return null;
  })();

  if (isSubagent) {
    return (
      <SubagentGroup
        row={row}
        selectedSpanId={selectedSpanId}
        onSelect={onSelect}
        orgId={orgId}
        traceId={traceId}
        depth={depth}
      >
        <div className="space-y-space-2">
          <RowExpandedPanels row={row} orgId={orgId} traceId={traceId} />
        </div>
        {row.children && row.children.length > 0 ? (
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
        ) : null}
      </SubagentGroup>
    );
  }

  return (
    <div data-span-id={row.span_id} data-span-kind={kind}>
      <div
        className={`group flex items-center gap-space-2 rounded-md border px-space-3 py-space-2 transition-colors ${
          selected
            ? "border-[var(--accent)] bg-[var(--bg-tertiary)]"
            : "border-transparent hover:border-[var(--border-default)] hover:bg-[var(--bg-secondary)]"
        }`}
        style={{ marginLeft: depth * 16 }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse details" : "Expand details"}
          aria-expanded={expanded}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded p-space-1 -m-space-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
          aria-label={`Select span ${row.name || row.event_type || row.span_id.slice(0, 12)}`}
          className="-my-space-1 -mr-space-1 flex min-w-0 flex-1 items-center gap-space-2 rounded py-space-1 pr-space-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
        >
          <SpanKindPill kind={kind} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {row.name || row.event_type || row.span_id.slice(0, 12)}
          </span>
          {!expanded && inlinePreview ? (
            <span
              className="hidden max-w-[12rem] truncate text-xs text-[var(--text-muted)] sm:inline"
              data-testid="span-inline-preview"
              title={inlinePreview}
            >
              {inlinePreview}
            </span>
          ) : null}
          <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
            {formatDuration(row.duration_ms)}
          </span>
          {kind === "llm" && row.streaming_metrics?.ttft_ms != null && (
            <span className="font-mono text-xs tabular-nums text-[var(--terminal)]">
              TTFT {Math.round(row.streaming_metrics.ttft_ms)}ms
            </span>
          )}
          {row.cache_hit && (
            <span className="rounded bg-[var(--terminal)]/20 px-space-1 py-space-1 font-mono text-2xs text-[var(--terminal)]">
              CACHED
            </span>
          )}
          {(row.outcome === "failure" || row.outcome === "error") && (
            <AlertCircle className="h-3 w-3 text-[var(--error)]" />
          )}
        </button>
      </div>

      {expanded && (
        <div className="ml-7 mt-space-1 space-y-space-2 px-space-3 pb-space-2">
          <RowExpandedPanels row={row} orgId={orgId} traceId={traceId} />
        </div>
      )}

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
