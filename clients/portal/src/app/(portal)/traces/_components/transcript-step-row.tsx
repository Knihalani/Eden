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
  kindFromEventType,
} from "@/app/(portal)/traces/_lib/format";
import { cn } from "@/lib/utils";

type Props = {
  row: TranscriptRow;
  selected?: boolean;
  onSelect?: (spanId: string) => void;
};

function stringifyBody(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function kindClass(kind: string): string {
  switch (kind) {
    case "llm":
      return "text-[var(--accent-purple)]";
    case "tool":
      return "text-[var(--warning)]";
    case "subagent":
      return "text-[var(--accent-cyan,var(--terminal))]";
    case "error":
      return "text-[var(--error)]";
    default:
      return "text-[var(--text-muted)]";
  }
}

export function TranscriptStepRow({ row, selected, onSelect }: Props) {
  const t = useTranslations("traces.transcript");
  const [open, setOpen] = useState(false);
  const kind = kindFromEventType(row.event_type);
  const tokens =
    row.input_tokens != null || row.output_tokens != null
      ? (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
      : null;

  const inputText =
    row.request_body?.messages
      ?.map((m) => `${m.role}: ${m.content}`)
      .join("\n") ||
    stringifyBody(row.request_body) ||
    (row.tool_calls
      ? stringifyBody(row.tool_calls)
      : "");
  const outputText =
    stringifyBody(row.response_body) ||
    (row.tool_results ? stringifyBody(row.tool_results) : "");

  const hasIo = Boolean(inputText || outputText);

  return (
    <div
      data-testid="transcript-step-row"
      data-span-id={row.span_id}
      data-kind={kind}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "border-b border-[var(--border-subtle)] px-3 py-2.5",
        selected && "bg-[var(--bg-tertiary)]",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
          aria-expanded={open}
          aria-label={open ? t("collapse") : t("expand")}
          disabled={!hasIo}
          onClick={() => hasIo && setOpen((v) => !v)}
        >
          {hasIo ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : (
            <span className="inline-block h-3.5 w-3.5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => onSelect?.(row.span_id)}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <span
                className={cn(
                  "mr-2 text-xs font-medium",
                  kindClass(kind),
                )}
              >
                {kind}
              </span>
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {row.name}
              </span>
            </div>
            <span className="inline-flex flex-wrap items-center gap-2">
              <MetricInline
                label=""
                value={formatLatency(row.duration_ms)}
                mono
              />
              <MetricInline label="" value={formatTokens(tokens)} mono />
              <MetricInline label="" value={formatCost(row.cost_usd)} mono />
            </span>
          </div>
        </button>
      </div>
      {open && hasIo ? (
        <div className="mt-2 space-y-2 pl-6">
          {inputText ? (
            <div data-testid="transcript-io-input">
              <p className="m-0 mb-1 text-xs font-medium text-[var(--text-muted)]">
                {t("input")}
              </p>
              <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2 font-mono text-xs text-[var(--text-secondary)]">
                {inputText.length > 400 && !open
                  ? `${inputText.slice(0, 400)}…`
                  : inputText}
              </pre>
            </div>
          ) : null}
          {outputText ? (
            <div data-testid="transcript-io-output">
              <p className="m-0 mb-1 text-xs font-medium text-[var(--text-muted)]">
                {t("output")}
              </p>
              <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2 font-mono text-xs text-[var(--text-secondary)]">
                {outputText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
