/**
 * Improve hub URL grammar — parse / normalize / write (surfaces/improve.md §3).
 */

export const IMPROVE_TABS = [
  "queue",
  "plans",
  "artifacts",
  "promotions",
  "ledger",
  "history",
] as const;
export type ImproveTab = (typeof IMPROVE_TABS)[number];

export const IMPROVE_QUEUE_STATUSES = [
  "needs_you",
  "in_progress",
  "verify",
  "done",
  "blocked",
] as const;
export type ImproveQueueStatus = (typeof IMPROVE_QUEUE_STATUSES)[number];

export const IMPROVE_PLAN_PANELS = [
  "evidence",
  "rca",
  "code",
  "artifacts",
  "pr",
  "activity",
] as const;
export type ImprovePlanPanel = (typeof IMPROVE_PLAN_PANELS)[number];

export type ImproveUrlState = {
  tab: ImproveTab;
  planId?: string;
  artifactId?: string;
  promotionId?: string;
  /** Ledger entry selection (`tab=ledger`). */
  entryId?: string;
  agentId?: string;
  issueId?: string;
  alertId?: string;
  experimentId?: string;
  baselineId?: string;
  traceId?: string;
  status?: ImproveQueueStatus;
  q?: string;
  filter?: string;
  viewId?: string;
  pastHours?: string;
  from?: string;
  to?: string;
  /** Comma-separated evidence trace ids (Create Plan handoff). */
  evidence?: string;
  /** Plan detail panel (`/improve/plans/[id]`). */
  panel?: ImprovePlanPanel;
};

const DEFAULT_TAB: ImproveTab = "queue";
const DEFAULT_PANEL: ImprovePlanPanel = "evidence";

const ID_ALIASES = {
  planId: ["planId", "plan_id"],
  artifactId: ["artifactId", "artifact_id"],
  promotionId: ["promotionId", "promotion_id"],
  entryId: ["entryId", "entry_id"],
  agentId: ["agent", "agentId", "agent_id"],
  issueId: ["issueId", "issue_id"],
  alertId: ["alertId", "alert_id"],
  experimentId: ["experimentId", "experiment_id"],
  baselineId: ["baselineId", "baseline_id"],
  traceId: ["traceId", "trace_id"],
  viewId: ["viewId", "savedView"],
} as const;

type IdKey = keyof typeof ID_ALIASES;

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

function readId(params: URLSearchParams, kind: IdKey): string | undefined {
  return firstNonEmpty(params, ID_ALIASES[kind]);
}

function writeId(
  params: URLSearchParams,
  kind: IdKey,
  value: string | undefined,
): void {
  const [canonical, ...aliases] = ID_ALIASES[kind];
  for (const alias of aliases) params.delete(alias);
  if (!value) params.delete(canonical);
  else params.set(canonical, value);
}

export function parseImproveTab(raw: string | null | undefined): ImproveTab {
  if (isIn(raw, IMPROVE_TABS)) return raw;
  return DEFAULT_TAB;
}

export function parseImprovePlanPanel(
  raw: string | null | undefined,
): ImprovePlanPanel {
  if (isIn(raw, IMPROVE_PLAN_PANELS)) return raw;
  return DEFAULT_PANEL;
}

export function parseImproveSearchParams(
  params: URLSearchParams,
): ImproveUrlState {
  const statusRaw = params.get("status");
  const panelRaw = params.get("panel");

  return {
    tab: parseImproveTab(params.get("tab")),
    planId: readId(params, "planId"),
    artifactId: readId(params, "artifactId"),
    promotionId: readId(params, "promotionId"),
    entryId: readId(params, "entryId"),
    agentId: readId(params, "agentId"),
    issueId: readId(params, "issueId"),
    alertId: readId(params, "alertId"),
    experimentId: readId(params, "experimentId"),
    baselineId: readId(params, "baselineId"),
    traceId: readId(params, "traceId"),
    status: isIn(statusRaw, IMPROVE_QUEUE_STATUSES) ? statusRaw : undefined,
    q: params.get("q") || undefined,
    filter: params.get("filter") || undefined,
    viewId: readId(params, "viewId"),
    pastHours: params.get("pastHours") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    evidence: params.get("evidence") || undefined,
    panel: panelRaw
      ? parseImprovePlanPanel(panelRaw)
      : undefined,
  };
}

/** Alias → camelCase normalize; drop empties of known aliases. */
export function normalizeImproveSearchParams(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const kind of Object.keys(ID_ALIASES) as IdKey[]) {
    writeId(next, kind, readId(next, kind));
  }
  const tab = parseImproveTab(next.get("tab"));
  if (tab === DEFAULT_TAB) next.delete("tab");
  else next.set("tab", tab);

  const status = next.get("status");
  if (status && !isIn(status, IMPROVE_QUEUE_STATUSES)) next.delete("status");

  const panel = next.get("panel");
  if (panel) {
    const parsed = parseImprovePlanPanel(panel);
    if (parsed === DEFAULT_PANEL) next.delete("panel");
    else next.set("panel", parsed);
  }

  return next;
}

export function writeImproveSearchParams(
  patch: Partial<ImproveUrlState>,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base?.toString() ?? "");
  const setOrDelete = (key: string, value: string | undefined) => {
    if (!value) params.delete(key);
    else params.set(key, value);
  };

  if ("tab" in patch) {
    if (!patch.tab || patch.tab === DEFAULT_TAB) params.delete("tab");
    else params.set("tab", patch.tab);
  }

  if ("planId" in patch) writeId(params, "planId", patch.planId);
  if ("artifactId" in patch) writeId(params, "artifactId", patch.artifactId);
  if ("promotionId" in patch)
    writeId(params, "promotionId", patch.promotionId);
  if ("entryId" in patch) writeId(params, "entryId", patch.entryId);
  if ("agentId" in patch) writeId(params, "agentId", patch.agentId);
  if ("issueId" in patch) writeId(params, "issueId", patch.issueId);
  if ("alertId" in patch) writeId(params, "alertId", patch.alertId);
  if ("experimentId" in patch)
    writeId(params, "experimentId", patch.experimentId);
  if ("baselineId" in patch) writeId(params, "baselineId", patch.baselineId);
  if ("traceId" in patch) writeId(params, "traceId", patch.traceId);
  if ("viewId" in patch) writeId(params, "viewId", patch.viewId);

  if ("status" in patch) setOrDelete("status", patch.status);
  if ("q" in patch) setOrDelete("q", patch.q);
  if ("filter" in patch) setOrDelete("filter", patch.filter);
  if ("pastHours" in patch) setOrDelete("pastHours", patch.pastHours);
  if ("from" in patch) setOrDelete("from", patch.from);
  if ("to" in patch) setOrDelete("to", patch.to);
  if ("evidence" in patch) setOrDelete("evidence", patch.evidence);

  if ("panel" in patch) {
    if (!patch.panel || patch.panel === DEFAULT_PANEL) params.delete("panel");
    else params.set("panel", patch.panel);
  }

  return params;
}

/** Esc clears selection ids only — keep tab / filters / time window. */
export function clearImproveSelection(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  writeId(next, "planId", undefined);
  writeId(next, "artifactId", undefined);
  writeId(next, "promotionId", undefined);
  writeId(next, "entryId", undefined);
  writeId(next, "issueId", undefined);
  writeId(next, "alertId", undefined);
  writeId(next, "experimentId", undefined);
  writeId(next, "baselineId", undefined);
  writeId(next, "traceId", undefined);
  next.delete("evidence");
  return next;
}

export function improveSearchParamsEqual(
  a: URLSearchParams,
  b: URLSearchParams,
): boolean {
  return a.toString() === b.toString();
}

export function improveQueryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
