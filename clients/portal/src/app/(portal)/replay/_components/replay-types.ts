export interface TracePickerItem {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
  user_id?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
  first_user_message?: string | null;
}

export interface TraceSession {
  session_id: string;
  trace_ids: string[];
  agent_id: string | null;
  started_at: string;
  ended_at: string;
}

export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface TraceEventItem {
  event_id: string;
  event_type: string;
  timestamp: string;
  sequence: number;
  tenant_id: string;
  user_id: string;
  entity_id: string;
  priority: string;
  payload: Record<string, unknown>;
  version: string;
}

export interface TraceSummary {
  event_count: number;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  types: Record<string, number>;
}

export type TabKey = "timeline" | "events";

export const EVENT_TYPE_COLORS: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  agent_thought: {
    bg: "bg-[var(--cat-purple-dim)]",
    text: "text-[var(--cat-purple-fg)]",
    border: "border-[var(--cat-purple-fg)]/20",
  },
  tool_call: {
    bg: "bg-[var(--cat-info-dim)]",
    text: "text-[var(--cat-info-fg)]",
    border: "border-[var(--cat-info-fg)]/20",
  },
  tool_result: {
    bg: "bg-[var(--terminal)]/10",
    text: "text-[var(--terminal)]",
    border: "border-[var(--terminal)]/20",
  },
  stage_transition: {
    bg: "bg-[var(--warning)]/10",
    text: "text-[var(--warning)]",
    border: "border-[var(--warning)]/20",
  },
  error: {
    bg: "bg-[var(--error)]/10",
    text: "text-[var(--error)]",
    border: "border-[var(--error)]/20",
  },
  system: {
    bg: "bg-[var(--bg-tertiary)]",
    text: "text-[var(--text-muted)]",
    border: "border-[var(--border-default)]",
  },
  user_message: {
    bg: "bg-[var(--accent-faint)]",
    text: "text-[var(--accent)]",
    border: "border-[var(--accent-dim)]",
  },
};

export function getEventTypeColor(eventType: string) {
  return EVENT_TYPE_COLORS[eventType] || EVENT_TYPE_COLORS.system;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString() +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

export function buildSessions(traces: TracePickerItem[]): TraceSession[] {
  if (traces.length === 0) return [];
  const sorted = [...traces].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const byExplicit = new Map<string, TraceSession>();
  const heuristic: TraceSession[] = [];
  let current: TraceSession | null = null;
  let lastTs = 0;
  let lastAgent: string | null = null;
  for (const t of sorted) {
    const explicit = t.session_id?.trim();
    if (explicit) {
      let sess = byExplicit.get(explicit);
      if (!sess) {
        sess = {
          session_id: explicit,
          trace_ids: [],
          agent_id: t.agent_id ?? null,
          started_at: t.created_at,
          ended_at: t.created_at,
        };
        byExplicit.set(explicit, sess);
      }
      sess.trace_ids.push(t.job_id);
      sess.ended_at = t.created_at;
      continue;
    }
    const ts = new Date(t.created_at).getTime();
    const agent = t.agent_id ?? null;
    const sameAgent = agent === lastAgent;
    const close = ts - lastTs <= SESSION_GAP_MS;
    if (!current || !sameAgent || !close) {
      current = {
        session_id: `sess_${(ts || Math.random()).toString(36)}`,
        trace_ids: [],
        agent_id: agent,
        started_at: t.created_at,
        ended_at: t.created_at,
      };
      heuristic.push(current);
    }
    current.trace_ids.push(t.job_id);
    current.ended_at = t.created_at;
    lastTs = ts;
    lastAgent = agent;
  }
  return [...byExplicit.values(), ...heuristic];
}
