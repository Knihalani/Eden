import { catalogTraces } from "@/lib/portal-catalog";

export type TranscriptStep = {
  id: string;
  kind: "task" | "llm" | "tool" | "bash" | "span" | "agent" | "handoff";
  title: string;
  durationMs: number;
  status?: "ok" | "error";
  startedAt?: string;
  /** Span / span id Eden assigns */
  spanId?: string;
  parentId?: string;
  /** Agent that produced this span (multi-agent traces). */
  agentId?: string;
  model?: string;
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** Structured attributes Eden collected */
  attributes?: Record<string, string | number | boolean>;
  inputPreview?: string;
  outputPreview?: string;
  errorMessage?: string;
  metadata?: Record<string, string>;
};

export type TraceFixture = {
  id: string;
  agentId: string;
  /** Distinct agent ids that participated on any span in this trace. */
  participants?: string[];
  name: string;
  status: "ok" | "error";
  startedAt: string;
  durationMs: number;
  tokens: number;
  /** null = cost unknown (unstamped / degraded). */
  costUsd: number | null;
  /** Hard failure or soft warning */
  severity: "error" | "warn" | "none";
  /** Multi-turn thread this run belongs to (G6 Sessions). */
  sessionId?: string;
  signals: { title: string; body: string; count?: number };
  steps: TranscriptStep[];
  /** W4-6 bookmarks: true when the authenticated user has starred this trace. */
  isBookmarked?: boolean;
};

export const TRACE_LIST: TraceFixture[] = [];

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export { formatUsd } from "@/lib/format";

/** Prefer the largest known cost; null when every candidate is unknown. */
export function preferKnownCostUsd(
  ...candidates: Array<number | null | undefined>
): number | null {
  const known = candidates.filter(
    (c): c is number => c != null && Number.isFinite(c),
  );
  if (known.length === 0) return null;
  return Math.max(...known);
}

export const TRACE_COUNTS = {
  all: TRACE_LIST.length,
  error: TRACE_LIST.filter((t) => t.severity === "error").length,
  warn: TRACE_LIST.filter((t) => t.severity === "warn").length,
  ok: TRACE_LIST.filter((t) => t.severity === "none").length,
} as const;

/** Minutes-ago rank from fixture labels — lower = newer. */
export function startedAtMinutesAgo(label: string): number {
  const m = label.trim().match(/^(\d+)\s*(m|h|d)\s*ago$/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  if (m[2].toLowerCase() === "h") return n * 60;
  if (m[2].toLowerCase() === "d") return n * 60 * 24;
  return n;
}

/** Newest first. Supports relative fixture labels and ISO timestamps. */
export function sortTracesNewestFirst(traces: TraceFixture[]): TraceFixture[] {
  return [...traces].sort((a, b) => {
    const aRel = startedAtMinutesAgo(a.startedAt);
    const bRel = startedAtMinutesAgo(b.startedAt);
    const aIsRel = aRel !== Number.MAX_SAFE_INTEGER;
    const bIsRel = bRel !== Number.MAX_SAFE_INTEGER;
    if (aIsRel && bIsRel) return aRel - bRel;
    const aMs = Date.parse(a.startedAt);
    const bMs = Date.parse(b.startedAt);
    if (!Number.isNaN(aMs) && !Number.isNaN(bMs)) return bMs - aMs;
    if (aIsRel) return -1;
    if (bIsRel) return 1;
    return 0;
  });
}

export function traceById(id: string): TraceFixture | undefined {
  return liveTraces().find((t) => t.id === id);
}
