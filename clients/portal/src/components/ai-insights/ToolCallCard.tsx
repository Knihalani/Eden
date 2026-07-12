"use client";

/**
 * ToolCallCard — renders one server-side tool call inside the AI
 * Insights chat stream.
 *
 * Three states:
 *   - "running": the assistant just emitted the tool call. We show
 *     a spinner with the tool name and a compact JSON dump of the
 *     input so the user can see what the LLM is asking for.
 *   - "ok": the result landed. We show the name, duration, a
 *     scrollable JSON dump, and deep links to Traces / Inspector /
 *     Issues when ids are present in the output.
 *   - "error": red border, error message, no output.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  ExternalLink,
} from "lucide-react";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

export interface ToolCallCardProps {
  /** The Anthropic tool_use id, used as a React key by the parent. */
  id: string;
  /** Tool name as registered in the backend (e.g. "list_traces"). */
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

type DeepLink = { href: string; label: string };

function collectDeepLinks(output: unknown): DeepLink[] {
  const links: DeepLink[] = [];
  const seen = new Set<string>();

  const push = (href: string, label: string) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    links.push({ href, label });
  };

  const walk = (value: unknown, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 25)) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.traces_url === "string") {
      push(obj.traces_url, "Open in Traces");
    }
    if (typeof obj.inspector_url === "string") {
      push(obj.inspector_url, "Open in Inspector");
    }
    if (typeof obj.issues_url === "string") {
      push(obj.issues_url, "Open issue");
    }
    if (typeof obj.inbox_url === "string") {
      push(obj.inbox_url, "Open patch inbox");
    }
    if (
      typeof obj.trace_id === "string" &&
      obj.trace_id &&
      !obj.traces_url
    ) {
      push(`/traces?trace_id=${encodeURIComponent(obj.trace_id)}`, "Open in Traces");
      push(
        `/observability?trace_id=${encodeURIComponent(obj.trace_id)}`,
        "Open in Inspector",
      );
    }
    if (typeof obj.issue_id === "string" && obj.issue_id && !obj.issues_url) {
      push(`/issues/${encodeURIComponent(obj.issue_id)}`, "Open issue");
    }
    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === "object") walk(nested, depth + 1);
    }
  };

  walk(output);
  return links.slice(0, 8);
}

function Sparkline({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const max = Math.max(...series, 1e-9);
  const min = Math.min(...series, 0);
  const span = Math.max(max - min, 1e-9);
  const w = 120;
  const h = 28;
  const pts = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="mt-2 block text-[var(--accent)]"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={pts}
      />
    </svg>
  );
}

function extractSeries(output: unknown): number[] | null {
  if (!output || typeof output !== "object") return null;
  const series = (output as { series?: unknown }).series;
  if (!Array.isArray(series) || series.length < 2) return null;
  const nums = series
    .map((row) => {
      if (typeof row === "number") return row;
      if (row && typeof row === "object" && "cost_usd" in row) {
        return Number((row as { cost_usd: unknown }).cost_usd);
      }
      return NaN;
    })
    .filter((n) => Number.isFinite(n));
  return nums.length >= 2 ? nums : null;
}

export function ToolCallCard({ id, name, input, result }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isRunning = !result;
  const isError = result?.status === "error";
  const deepLinks = useMemo(
    () => (result?.status === "ok" ? collectDeepLinks(result.output) : []),
    [result],
  );
  const spark = useMemo(
    () => (result?.status === "ok" ? extractSeries(result.output) : null),
    [result],
  );

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

      {deepLinks.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
          {deepLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {link.label}
            </Link>
          ))}
        </div>
      )}

      {spark && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-1">
          <Sparkline series={spark} />
        </div>
      )}

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
