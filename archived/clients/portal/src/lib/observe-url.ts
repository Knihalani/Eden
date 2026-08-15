/**
 * Observe URL grammar — parse / normalize / write for Traces hub +
 * shared Issues/Alerts selection params (IA §3, surfaces/traces.md §3).
 */

export const OBSERVE_VIEWS = ["traces", "spans", "sessions"] as const;
export type ObserveView = (typeof OBSERVE_VIEWS)[number];

export const OBSERVE_MODES = [
  "transcript",
  "tree",
  "timeline",
  "meta",
  "scores",
] as const;
export type ObserveMode = (typeof OBSERVE_MODES)[number];

export const OBSERVE_FACETS = [
  "mcp",
  "decisions",
  "memory",
  "retrieval",
] as const;
export type ObserveFacet = (typeof OBSERVE_FACETS)[number];

export const OBSERVE_OUTCOMES = ["error", "ok", "unknown"] as const;
export type ObserveOutcome = (typeof OBSERVE_OUTCOMES)[number];

/** Cross-link preserve set (IA §3.6). */
export const OBSERVE_FILTER_PRESERVE_KEYS = [
  "pastHours",
  "from",
  "to",
  "q",
  "filter",
  "agentId",
  "outcome",
  "realm",
  "viewId",
] as const;

export type ObserveFilterPreserveKey =
  (typeof OBSERVE_FILTER_PRESERVE_KEYS)[number];

/** Canonical identity keys + read aliases. */
export const OBSERVE_ID_ALIASES = {
  traceId: ["traceId", "trace_id", "trace"],
  spanId: ["spanId", "span_id", "span"],
  sessionId: ["sessionId", "session_id"],
  agentId: ["agent", "agentId", "agent_id"],
  issueId: ["issueId", "issue_id"],
  alertId: ["alertId", "alert_id"],
  viewId: ["viewId", "savedView"],
} as const;

export type ObserveIdKey = keyof typeof OBSERVE_ID_ALIASES;

export type ObserveUrlState = {
  view: ObserveView;
  mode?: ObserveMode;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  issueId?: string;
  alertId?: string;
  agentId?: string;
  q?: string;
  filter?: string;
  pastHours?: string;
  from?: string;
  to?: string;
  outcome?: ObserveOutcome;
  realm?: string;
  facet?: ObserveFacet;
  live?: "0" | "1";
  viewId?: string;
  /** Issues / Alerts hub tab. */
  tab?: string;
};

const DEFAULT_VIEW: ObserveView = "traces";
const DEFAULT_MODE: ObserveMode = "transcript";

function isIn<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
): value is T {
  return Boolean(value && (allowed as readonly string[]).includes(value));
}

function firstNonEmpty(
  params: URLSearchParams,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = params.get(key);
    if (v) return v;
  }
  return undefined;
}

/** Legacy `view=` values that leave Traces for Debugger (IA §3.4). */
const LEGACY_DEBUGGER_VIEWS = {
  replay: "replay",
  debug: "compare",
  "time-travel": "time-travel",
} as const;

/** Map legacy embed `view=` values (IA §3.4) onto hub lens + mode. */
function mapLegacyView(raw: string | null): {
  view?: ObserveView;
  mode?: ObserveMode;
} {
  if (!raw) return {};
  if (isIn(raw, OBSERVE_VIEWS)) return { view: raw };
  if (raw === "inspect") return { mode: "meta" };
  // replay / debug / time-travel → external debugger (see legacyObserveExternalRedirect)
  // query / cohorts — ignore as hub lens
  return {};
}

/**
 * When `/traces?view=replay|debug|time-travel` is opened, send the user to
 * Debugger with an optional seed `traceId` (surfaces/traces.md §3.4).
 */
export function legacyObserveExternalRedirect(
  params: URLSearchParams,
): string | null {
  const view = params.get("view");
  if (!view || !(view in LEGACY_DEBUGGER_VIEWS)) return null;
  const tab =
    LEGACY_DEBUGGER_VIEWS[view as keyof typeof LEGACY_DEBUGGER_VIEWS];
  const next = new URLSearchParams();
  next.set("tab", tab);
  const traceId = readObserveIdParam(params, "traceId");
  if (traceId) next.set("traceId", traceId);
  return `/debugger?${next.toString()}`;
}

export function readObserveIdParam(
  params: URLSearchParams,
  kind: ObserveIdKey,
): string | undefined {
  return firstNonEmpty(params, OBSERVE_ID_ALIASES[kind]);
}

export function writeObserveIdParam(
  params: URLSearchParams,
  kind: ObserveIdKey,
  value: string | undefined,
): void {
  const [canonical, ...aliases] = OBSERVE_ID_ALIASES[kind];
  for (const alias of aliases) params.delete(alias);
  if (!value) params.delete(canonical);
  else params.set(canonical, value);
}

/** Parse URLSearchParams into typed Observe state (defaults applied). */
export function parseObserveSearchParams(
  params: URLSearchParams,
): ObserveUrlState {
  const legacy = mapLegacyView(params.get("view"));
  const view: ObserveView = legacy.view ?? DEFAULT_VIEW;

  const modeRaw = params.get("mode");
  let mode: ObserveMode | undefined = isIn(modeRaw, OBSERVE_MODES)
    ? modeRaw
    : legacy.mode;

  const traceId = readObserveIdParam(params, "traceId");
  const spanId = readObserveIdParam(params, "spanId");
  const sessionId = readObserveIdParam(params, "sessionId");
  const issueId = readObserveIdParam(params, "issueId");
  const alertId = readObserveIdParam(params, "alertId");
  const agentId = readObserveIdParam(params, "agentId");
  const viewId = readObserveIdParam(params, "viewId");

  if (traceId && !mode) mode = DEFAULT_MODE;

  const outcomeRaw = params.get("outcome");
  const facetRaw = params.get("facet");
  const liveRaw = params.get("live");

  return {
    view,
    mode,
    traceId,
    spanId,
    sessionId,
    issueId,
    alertId,
    agentId,
    q: params.get("q") || undefined,
    filter: params.get("filter") || undefined,
    pastHours: params.get("pastHours") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    outcome: isIn(outcomeRaw, OBSERVE_OUTCOMES) ? outcomeRaw : undefined,
    realm: params.get("realm") || undefined,
    facet: isIn(facetRaw, OBSERVE_FACETS) ? facetRaw : undefined,
    live: liveRaw === "1" || liveRaw === "0" ? liveRaw : undefined,
    viewId,
    tab: params.get("tab") || undefined,
  };
}

/**
 * Alias → camelCase normalize in place. Drops snake_case / short aliases
 * after copying onto canonical keys. Does not strip unrelated params.
 */
export function normalizeObserveSearchParams(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const kind of Object.keys(OBSERVE_ID_ALIASES) as ObserveIdKey[]) {
    const value = readObserveIdParam(next, kind);
    writeObserveIdParam(next, kind, value);
  }

  const legacy = mapLegacyView(next.get("view"));
  if (legacy.view) {
    next.set("view", legacy.view);
  } else if (next.get("view") && !isIn(next.get("view"), OBSERVE_VIEWS)) {
    next.delete("view");
    if (legacy.mode && !next.get("mode")) next.set("mode", legacy.mode);
  }

  return next;
}

/** Write partial state; omit empties; drop aliases; skip default view. */
export function writeObserveSearchParams(
  patch: Partial<ObserveUrlState>,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base?.toString() ?? "");

  const setOrDelete = (key: string, value: string | undefined) => {
    if (!value) params.delete(key);
    else params.set(key, value);
  };

  if ("view" in patch) {
    if (!patch.view || patch.view === DEFAULT_VIEW) params.delete("view");
    else params.set("view", patch.view);
  }
  if ("mode" in patch) {
    // Default transcript is implied when traceId is set — omit from share URLs.
    if (!patch.mode || patch.mode === DEFAULT_MODE) params.delete("mode");
    else params.set("mode", patch.mode);
  }

  if ("traceId" in patch) writeObserveIdParam(params, "traceId", patch.traceId);
  if ("spanId" in patch) writeObserveIdParam(params, "spanId", patch.spanId);
  if ("sessionId" in patch)
    writeObserveIdParam(params, "sessionId", patch.sessionId);
  if ("issueId" in patch) writeObserveIdParam(params, "issueId", patch.issueId);
  if ("alertId" in patch) writeObserveIdParam(params, "alertId", patch.alertId);
  if ("agentId" in patch) writeObserveIdParam(params, "agentId", patch.agentId);
  if ("viewId" in patch) writeObserveIdParam(params, "viewId", patch.viewId);

  if ("q" in patch) setOrDelete("q", patch.q);
  if ("filter" in patch) setOrDelete("filter", patch.filter);
  if ("pastHours" in patch) setOrDelete("pastHours", patch.pastHours);
  if ("from" in patch) setOrDelete("from", patch.from);
  if ("to" in patch) setOrDelete("to", patch.to);
  if ("outcome" in patch) setOrDelete("outcome", patch.outcome);
  if ("realm" in patch) setOrDelete("realm", patch.realm);
  if ("facet" in patch) setOrDelete("facet", patch.facet);
  if ("live" in patch) {
    if (!patch.live || patch.live === "0") params.delete("live");
    else params.set("live", patch.live);
  }
  if ("tab" in patch) setOrDelete("tab", patch.tab);

  return params;
}

/** Copy only the cross-link preserve-set keys (canonical agentId). */
export function preserveObserveFilters(
  from: URLSearchParams,
): URLSearchParams {
  const out = new URLSearchParams();
  const agentId = readObserveIdParam(from, "agentId");
  const viewId = readObserveIdParam(from, "viewId");
  for (const key of OBSERVE_FILTER_PRESERVE_KEYS) {
    if (key === "agentId") {
  if (agentId) out.set("agent", agentId);
      continue;
    }
    if (key === "viewId") {
      if (viewId) out.set("viewId", viewId);
      continue;
    }
    const v = from.get(key);
    if (v) out.set(key, v);
  }
  return out;
}

/**
 * Progressive Esc clear (sessions.md): span → trace → session.
 * Issues/Alerts: clear issueId / alertId when present.
 * Never wipes filters / view / tab.
 */
export function clearObserveSelection(
  params: URLSearchParams,
  level: "span" | "trace" | "session" | "issue" | "alert" | "all" = "all",
): URLSearchParams {
  const next = new URLSearchParams(params.toString());

  if (level === "span") {
    writeObserveIdParam(next, "spanId", undefined);
    return next;
  }
  if (level === "trace") {
    writeObserveIdParam(next, "spanId", undefined);
    writeObserveIdParam(next, "traceId", undefined);
    next.delete("mode");
    return next;
  }
  if (level === "session") {
    writeObserveIdParam(next, "spanId", undefined);
    writeObserveIdParam(next, "traceId", undefined);
    writeObserveIdParam(next, "sessionId", undefined);
    next.delete("mode");
    return next;
  }
  if (level === "issue") {
    writeObserveIdParam(next, "issueId", undefined);
    return next;
  }
  if (level === "alert") {
    writeObserveIdParam(next, "alertId", undefined);
    return next;
  }

  writeObserveIdParam(next, "spanId", undefined);
  writeObserveIdParam(next, "traceId", undefined);
  writeObserveIdParam(next, "sessionId", undefined);
  writeObserveIdParam(next, "issueId", undefined);
  writeObserveIdParam(next, "alertId", undefined);
  next.delete("mode");
  return next;
}

/**
 * One Esc step: clear the innermost selection id first.
 * Returns a new URLSearchParams (may be equal if nothing to clear).
 */
export function progressiveEscClear(
  params: URLSearchParams,
): URLSearchParams {
  if (readObserveIdParam(params, "spanId")) {
    return clearObserveSelection(params, "span");
  }
  if (readObserveIdParam(params, "traceId")) {
    return clearObserveSelection(params, "trace");
  }
  if (readObserveIdParam(params, "sessionId")) {
    return clearObserveSelection(params, "session");
  }
  if (readObserveIdParam(params, "issueId")) {
    return clearObserveSelection(params, "issue");
  }
  if (readObserveIdParam(params, "alertId")) {
    return clearObserveSelection(params, "alert");
  }
  return new URLSearchParams(params.toString());
}

export function observeSearchParamsEqual(
  a: URLSearchParams,
  b: URLSearchParams,
): boolean {
  return a.toString() === b.toString();
}

/** Build `?qs` or `` for router.replace. */
export function observeQueryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
