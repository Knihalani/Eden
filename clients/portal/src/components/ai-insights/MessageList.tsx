"use client";

import type { RefObject } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Download } from "lucide-react";
import type { AiChartSpec } from "@/lib/api";
import { downloadCsv, downloadXlsx } from "@/lib/export";
import { Button } from "@/components/ui/button";
import { citationJumpHref } from "@/lib/portal-cross-links";
import { cn } from "@/lib/utils";
import { ToolCallCard } from "./ToolCallCard";
import { ApprovalCard } from "./ApprovalCard";
import { needsApproval, type Message, type ChatCitation } from "./types";

// Keep recharts out of the ChatSidebar island until a message actually
// emits charts (bundle budget: recharts alone is ~412KB).
const AiChartRenderer = dynamic(
  () =>
    import("@/components/ai/ai-chart-renderer").then((m) => ({
      default: m.AiChartRenderer,
    })),
  { ssr: false },
);

function CitationChip({ cite }: { cite: ChatCitation }) {
  const href = citationJumpHref(cite);
  const label = cite.label || `${cite.kind}:${cite.id.slice(0, 8)}`;
  const spanId = cite.kind === "span" ? cite.id : undefined;
  if (href) {
    return (
      <Link
        href={href}
        className="inline-flex rounded bg-[var(--bg-tertiary)] px-space-2 py-space-1 text-2xs text-[var(--accent)] hover:underline"
        data-citation-chip
        data-citation-kind={cite.kind}
        {...(spanId ? { "data-span-id": spanId } : {})}
      >
        {label}
      </Link>
    );
  }
  return (
    <span
      className="inline-flex rounded bg-[var(--bg-tertiary)] px-space-2 py-space-1 text-2xs text-[var(--text-muted)]"
      data-citation-chip
      data-citation-kind={cite.kind}
      {...(spanId ? { "data-span-id": spanId } : {})}
    >
      {label}
    </span>
  );
}

function downloadChartBundle(charts: AiChartSpec[]) {
  const rows: Array<Record<string, unknown>> = [];
  charts.forEach((chart, i) => {
    const title = chart.title || `chart_${i + 1}`;
    for (const row of chart.data ?? []) {
      rows.push({ chart: title, type: chart.type, ...(row as Record<string, unknown>) });
    }
  });
  if (rows.length === 0) return;
  downloadXlsx("eden-charts-bundle.xlsx", rows);
  downloadCsv("eden-charts-bundle.csv", rows);
}

function MessageBlock({
  message,
  sessionId,
}: {
  message: Message;
  sessionId: string | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-[var(--accent)] px-space-3 py-space-2 text-sm text-[var(--bg-base)]">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.role === "assistant") {
    const charts = (message.charts ?? []) as AiChartSpec[];
    return (
      <div className="flex justify-start">
        <div
          className={cn(
            "max-w-[90%] space-y-space-2 rounded-lg border px-space-3 py-space-2 text-sm",
            message.isError
              ? "border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]"
              : "border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)]",
          )}
        >
          {message.toolCalls?.map((tc) =>
            needsApproval(tc) ? (
              <ApprovalCard
                key={tc.id}
                id={tc.id}
                name={tc.name}
                input={tc.input}
                result={tc.result}
                sessionId={sessionId}
              />
            ) : (
              <ToolCallCard
                key={tc.id}
                id={tc.id}
                name={tc.name}
                input={tc.input}
                result={tc.result}
              />
            ),
          )}
          {charts.length > 1 && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-space-1 text-xs"
                aria-label="Download all charts as CSV/XLSX bundle"
                onClick={() => downloadChartBundle(charts)}
              >
                <Download className="h-3 w-3" aria-hidden />
                Bundle charts
              </Button>
            </div>
          )}
          {charts.map((chart, i) => (
            <AiChartRenderer
              key={`chart-${i}`}
              chart={chart}
              height={180}
            />
          ))}
          {message.citations && message.citations.length > 0 && (
            <div className="flex flex-wrap gap-space-2">
              {message.citations.map((c, i) => (
                <CitationChip key={`${c.kind}-${c.id}-${i}`} cite={c} />
              ))}
            </div>
          )}
          {message.text && (
            <div className="whitespace-pre-wrap break-words">
              {message.text}
              {message.streaming && (
                <span className="ml-space-1 inline-block h-3 w-1 animate-pulse bg-[var(--accent)]" />
              )}
            </div>
          )}
          {typeof message.costUsd === "number" &&
            message.costUsd > 0 &&
            !message.streaming && (
              <div className="text-2xs tabular-nums text-[var(--text-muted)]">
                ${message.costUsd.toFixed(4)} this turn
              </div>
            )}
        </div>
      </div>
    );
  }
  return null;
}

export interface MessageListProps {
  messages: Message[];
  sessionId: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function MessageList({ messages, sessionId, scrollRef }: MessageListProps) {
  return (
    <div ref={scrollRef} className="flex-1 space-y-space-3 overflow-y-auto px-space-4 py-space-3">
      {messages.length === 0 && (
        <div className="rounded-md border border-dashed border-[var(--border-subtle)] p-space-3 text-xs text-[var(--text-muted)]">
          Capture. Analyse. Improve. Ask about traces, cost, evals, issues,
          proposed patches, or alerts.
          <ul className="mt-space-2 list-disc space-y-space-1 pl-space-4">
            <li>Show recent traces</li>
            <li>What&apos;s our p95 latency this week?</li>
            <li>Alert me if cost exceeds $0.30/hr for 15 minutes</li>
            <li>Any open agent issues or pending patches?</li>
          </ul>
        </div>
      )}
      {messages.map((m) => (
        <MessageBlock key={m.id} message={m} sessionId={sessionId} />
      ))}
    </div>
  );
}
