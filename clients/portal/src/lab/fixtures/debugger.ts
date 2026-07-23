/**
 * Lab Debugger fixtures — investigation sessions over Trace fixtures.
 * No live debuggerApi; shapes mirror product DebugSession intent.
 */

import {
  TRACE_LIST,
  formatDuration,
  formatTokens,
  formatUsd,
  traceById,
  type TraceFixture,
  type TranscriptStep,
} from "@/lab/fixtures/traces";
import { agentById } from "@/lab/fixtures/agents";
import {
  catalogDebuggerSessions,
  catalogTraces,
} from "@/lib/portal-catalog";

export type DebuggerMode = "replay" | "compare" | "inspect";

/** @deprecated URL alias — prefer inspect */
export type DebuggerModeUrl = DebuggerMode | "time-travel" | "notes";

export type DebuggerCheckpoint = {
  id: string;
  stepId: string;
  spanId?: string;
  label: string;
  kind: string;
  status: "ok" | "error";
  atMs: number;
  summary: string;
};

export type DebuggerSessionFixture = {
  id: string;
  title: string;
  agentId: string;
  sourceTraceId: string;
  compareTraceId?: string;
  updatedAt: string;
  modeHint: DebuggerMode;
  notes: string;
  /** Last fixture replay outcome (client-simulated). */
  lastReplay?: {
    at: string;
    fromCheckpointId: string;
    outcome: "ok" | "error";
    summary: string;
  };
};

/** Cumulative world-state after completing steps[0..index] inclusive. */
export type TimelineSnapshot = {
  index: number;
  step: TranscriptStep;
  checkpoint: DebuggerCheckpoint;
  elapsedMs: number;
  tokens: number;
  costUsd: number;
  model?: string;
  provider?: string;
  errorCount: number;
  attributes: Record<string, string | number | boolean>;
  entering: string;
  leaving: string;
  priorLeaving: string | null;
};

function checkpointsForTrace(trace: TraceFixture): DebuggerCheckpoint[] {
  let cursor = 0;
  return trace.steps.map((step) => {
    const atMs = cursor;
    cursor += step.durationMs;
    return {
      id: `cp_${trace.id}_${step.id}`,
      stepId: step.id,
      spanId: step.spanId,
      label: step.title,
      kind: step.kind,
      status: step.status === "error" ? "error" : "ok",
      atMs,
      summary:
        step.errorMessage ??
        step.outputPreview?.slice(0, 120) ??
        step.inputPreview?.slice(0, 120) ??
        `${step.kind} · ${step.durationMs}ms`,
    };
  });
}

export function sessionCheckpoints(
  session: DebuggerSessionFixture,
): DebuggerCheckpoint[] {
  const trace = traceById(session.sourceTraceId);
  if (!trace) return [];
  return checkpointsForTrace(trace);
}

export function snapshotAtIndex(
  trace: TraceFixture,
  checkpoints: DebuggerCheckpoint[],
  index: number,
): TimelineSnapshot | null {
  if (checkpoints.length === 0) return null;
  const i = Math.min(Math.max(index, 0), checkpoints.length - 1);
  const checkpoint = checkpoints[i]!;
  const step = trace.steps.find((s) => s.id === checkpoint.stepId);
  if (!step) return null;

  const prefix = trace.steps.slice(0, i + 1);
  let tokens = 0;
  let costUsd = 0;
  let model: string | undefined;
  let provider: string | undefined;
  let errorCount = 0;
  const attributes: Record<string, string | number | boolean> = {};

  for (const s of prefix) {
    tokens += (s.tokensIn ?? 0) + (s.tokensOut ?? 0);
    costUsd += s.costUsd ?? 0;
    if (s.model) model = s.model;
    if (s.provider) provider = s.provider;
    if (s.status === "error") errorCount += 1;
    if (s.attributes) Object.assign(attributes, s.attributes);
    if (s.metadata) Object.assign(attributes, s.metadata);
  }

  const prior =
    i > 0
      ? trace.steps.find((s) => s.id === checkpoints[i - 1]!.stepId)
      : null;

  return {
    index: i,
    step,
    checkpoint,
    elapsedMs: checkpoint.atMs + step.durationMs,
    tokens,
    costUsd,
    model,
    provider,
    errorCount,
    attributes,
    entering: step.inputPreview?.trim() || "—",
    leaving:
      step.errorMessage?.trim() ||
      step.outputPreview?.trim() ||
      (step.status === "error" ? "Failed with no message." : "—"),
    priorLeaving:
      prior?.errorMessage?.trim() || prior?.outputPreview?.trim() || null,
  };
}

export function modeHintLabel(mode: DebuggerMode): string {
  switch (mode) {
    case "replay":
      return "Replay";
    case "compare":
      return "Compare";
    case "inspect":
      return "Inspect";
  }
}

export function modeSubtitle(mode: DebuggerMode): string {
  switch (mode) {
    case "replay":
      return "Re-run from a step";
    case "compare":
      return "Diff two traces";
    case "inspect":
      return "State at this step";
  }
}

export const DEBUGGER_SESSIONS: DebuggerSessionFixture[] = [];

/** In-memory client-only sessions (trace handoff / New session). */
const CLIENT_SESSIONS: DebuggerSessionFixture[] = [];

function liveSessions(): DebuggerSessionFixture[] {
  const live = catalogDebuggerSessions();
  return live.length > 0 ? live : DEBUGGER_SESSIONS;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

/** Persist a client-created session so detail can resolve after navigation. */
export function rememberClientSession(session: DebuggerSessionFixture): void {
  const idx = CLIENT_SESSIONS.findIndex((s) => s.id === session.id);
  if (idx >= 0) CLIENT_SESSIONS[idx] = session;
  else CLIENT_SESSIONS.unshift(session);
}

export function defaultSessionId(): string {
  return CLIENT_SESSIONS[0]?.id ?? liveSessions()[0]?.id ?? "";
}

export function sessionById(id: string): DebuggerSessionFixture | undefined {
  return (
    CLIENT_SESSIONS.find((s) => s.id === id) ??
    liveSessions().find((s) => s.id === id)
  );
}

export function agentLabel(agentId: string): string {
  return agentById(agentId)?.name ?? agentId;
}

export function sourceTraceLabel(traceId: string): string {
  const t = traceById(traceId);
  return t ? `${t.id} · ${t.name}` : traceId;
}

/** Seed a new local session from a trace (list page handoff). */
export function sessionFromTrace(
  traceId: string,
  opts?: { spanId?: string; agentId?: string },
): DebuggerSessionFixture {
  const trace = traceById(traceId);
  const agentId = opts?.agentId ?? trace?.agentId ?? "";
  const name = trace?.name ?? traceId;
  const peer = liveTraces().find(
    (t) => t.agentId === agentId && t.id !== traceId,
  );
  const session: DebuggerSessionFixture = {
    id: `dbg_${Date.now().toString(36)}`,
    title: `Debug · ${name}`,
    agentId,
    sourceTraceId: traceId,
    compareTraceId: peer?.id,
    updatedAt: "just now",
    modeHint: "replay",
    notes: opts?.spanId
      ? `Seeded with span focus ${opts.spanId}.`
      : `Seeded from ${traceId}.`,
  };
  rememberClientSession(session);
  return session;
}

export function labDebuggerListHref(params: {
  agent?: string | null;
  q?: string | null;
  traceId?: string | null;
  spanId?: string | null;
} = {}): string {
  const p = new URLSearchParams();
  if (params.agent && params.agent !== "all") p.set("agent", params.agent);
  if (params.q) p.set("q", params.q);
  if (params.traceId) p.set("traceId", params.traceId);
  if (params.spanId) p.set("spanId", params.spanId);
  const qs = p.toString();
  return qs ? `/debugger?${qs}` : "/debugger";
}

export function labDebuggerDetailHref(
  sessionId: string,
  params: {
    mode?: DebuggerMode;
    leftTraceId?: string | null;
    rightTraceId?: string | null;
    traceId?: string | null;
    spanId?: string | null;
    agent?: string | null;
  } = {},
): string {
  const p = new URLSearchParams();
  if (params.mode) p.set("mode", params.mode);
  if (params.leftTraceId) p.set("leftTraceId", params.leftTraceId);
  if (params.rightTraceId) p.set("rightTraceId", params.rightTraceId);
  if (params.traceId) p.set("traceId", params.traceId);
  if (params.spanId) p.set("spanId", params.spanId);
  if (params.agent && params.agent !== "all") p.set("agent", params.agent);
  const qs = p.toString();
  return qs
    ? `/debugger/${encodeURIComponent(sessionId)}?${qs}`
    : `/debugger/${encodeURIComponent(sessionId)}`;
}

export function formatCheckpointTime(atMs: number): string {
  if (atMs < 1000) return `T+${atMs}ms`;
  if (atMs < 60_000) return `T+${(atMs / 1000).toFixed(1)}s`;
  return `T+${(atMs / 60_000).toFixed(1)}m`;
}

export { formatDuration, formatTokens, formatUsd };
