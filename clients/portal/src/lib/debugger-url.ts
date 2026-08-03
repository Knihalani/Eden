/**
 * Debugger URL grammar — tab, filters, detail mode.
 * Canonical per surfaces/debugger.md §4.
 */

export const DEBUGGER_TABS = ["sessions", "replay", "compare", "inspect", "time-travel"] as const;
export type DebuggerTab = (typeof DEBUGGER_TABS)[number];

export const DEBUGGER_MODES = ["replay", "compare", "inspect", "time-travel", "notes"] as const;
export type DebuggerMode = (typeof DEBUGGER_MODES)[number];

export interface DebuggerListParams {
  tab?: DebuggerTab;
  traceId?: string;
  spanId?: string;
  agentId?: string;
  sessionId?: string;
  q?: string;
  pastHours?: number;
  from?: string;
  to?: string;
}

export interface DebuggerDetailParams {
  mode?: DebuggerMode;
  /** Canonical compare pair (debugger.md §4.3). */
  leftTraceId?: string;
  rightTraceId?: string;
  traceId?: string;
  spanId?: string;
}

/** Build the list URL for /debugger. */
export function debuggerListHref(params: DebuggerListParams = {}): string {
  const p = new URLSearchParams();
  if (params.tab) p.set("tab", params.tab);
  if (params.traceId) p.set("traceId", params.traceId);
  if (params.spanId) p.set("spanId", params.spanId);
  if (params.agentId) p.set("agent", params.agentId);
  if (params.sessionId) p.set("sessionId", params.sessionId);
  if (params.q) p.set("q", params.q);
  if (params.pastHours != null) p.set("pastHours", String(params.pastHours));
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  const qs = p.toString();
  return qs ? `/debugger?${qs}` : "/debugger";
}

/** Build the detail URL for /debugger/[id]. */
export function debuggerDetailHref(
  sessionId: string,
  params: DebuggerDetailParams = {},
): string {
  const p = new URLSearchParams();
  if (params.mode) p.set("mode", params.mode);
  if (params.leftTraceId) p.set("leftTraceId", params.leftTraceId);
  if (params.rightTraceId) p.set("rightTraceId", params.rightTraceId);
  if (params.traceId) p.set("traceId", params.traceId);
  if (params.spanId) p.set("spanId", params.spanId);
  const qs = p.toString();
  return qs
    ? `/debugger/${encodeURIComponent(sessionId)}?${qs}`
    : `/debugger/${encodeURIComponent(sessionId)}`;
}

/** Parse DebuggerListParams from URLSearchParams. */
export function parseDebuggerListParams(
  params: URLSearchParams,
): DebuggerListParams {
  const tab = params.get("tab");
  return {
    tab: DEBUGGER_TABS.includes(tab as DebuggerTab)
      ? (tab as DebuggerTab)
      : undefined,
    traceId: params.get("traceId") ?? undefined,
    spanId: params.get("spanId") ?? undefined,
    agentId:
      params.get("agent") ??
      params.get("agentId") ??
      params.get("agent_id") ??
      undefined,
    sessionId: params.get("sessionId") ?? undefined,
    q: params.get("q") ?? undefined,
    pastHours: params.get("pastHours") ? Number(params.get("pastHours")) : undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  };
}

/** Parse DebuggerDetailParams from URLSearchParams. */
export function parseDebuggerDetailParams(
  params: URLSearchParams,
): DebuggerDetailParams {
  const mode = params.get("mode");
  return {
    mode: DEBUGGER_MODES.includes(mode as DebuggerMode)
      ? (mode as DebuggerMode)
      : undefined,
    leftTraceId: params.get("leftTraceId") ?? undefined,
    rightTraceId: params.get("rightTraceId") ?? undefined,
    traceId: params.get("traceId") ?? undefined,
    spanId: params.get("spanId") ?? undefined,
  };
}
