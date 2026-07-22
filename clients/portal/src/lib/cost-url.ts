/**
 * Cost hub URL grammar — parse / normalize / write (surfaces/cost.md §3).
 */

export const COST_TABS = [
  "overview",
  "budget",
  "outcomes",
  "forecast",
  "advisor",
] as const;
export type CostTab = (typeof COST_TABS)[number];

export const COST_GROUP_BY = ["agent", "model", "provider", "day"] as const;
export type CostGroupBy = (typeof COST_GROUP_BY)[number];

export type CostUrlState = {
  tab: CostTab;
  agentId?: string;
  budgetId?: string;
  model?: string;
  provider?: string;
  pastHours?: string;
  from?: string;
  to?: string;
  q?: string;
  filter?: string;
  viewId?: string;
  groupBy?: CostGroupBy;
};

const DEFAULT_TAB: CostTab = "overview";

const ID_ALIASES = {
  agentId: ["agentId", "agent_id"],
  budgetId: ["budgetId", "budget_id"],
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

export function parseCostTab(raw: string | null | undefined): CostTab {
  if (isIn(raw, COST_TABS)) return raw;
  return DEFAULT_TAB;
}

export function parseCostSearchParams(params: URLSearchParams): CostUrlState {
  const groupByRaw = params.get("groupBy");

  return {
    tab: parseCostTab(params.get("tab")),
    agentId: readId(params, "agentId"),
    budgetId: readId(params, "budgetId"),
    model: params.get("model") || undefined,
    provider: params.get("provider") || undefined,
    pastHours: params.get("pastHours") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    q: params.get("q") || undefined,
    filter: params.get("filter") || undefined,
    viewId: readId(params, "viewId"),
    groupBy: isIn(groupByRaw, COST_GROUP_BY) ? groupByRaw : undefined,
  };
}

/** Alias → camelCase normalize; drop empties of known aliases. */
export function normalizeCostSearchParams(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const kind of Object.keys(ID_ALIASES) as IdKey[]) {
    writeId(next, kind, readId(next, kind));
  }
  const tab = parseCostTab(next.get("tab"));
  if (tab === DEFAULT_TAB) next.delete("tab");
  else next.set("tab", tab);

  const groupBy = next.get("groupBy");
  if (groupBy && !isIn(groupBy, COST_GROUP_BY)) next.delete("groupBy");

  return next;
}

export function writeCostSearchParams(
  patch: Partial<CostUrlState>,
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

  if ("agentId" in patch) writeId(params, "agentId", patch.agentId);
  if ("budgetId" in patch) writeId(params, "budgetId", patch.budgetId);
  if ("viewId" in patch) writeId(params, "viewId", patch.viewId);

  if ("model" in patch) setOrDelete("model", patch.model);
  if ("provider" in patch) setOrDelete("provider", patch.provider);
  if ("pastHours" in patch) setOrDelete("pastHours", patch.pastHours);
  if ("from" in patch) setOrDelete("from", patch.from);
  if ("to" in patch) setOrDelete("to", patch.to);
  if ("q" in patch) setOrDelete("q", patch.q);
  if ("filter" in patch) setOrDelete("filter", patch.filter);
  if ("groupBy" in patch) setOrDelete("groupBy", patch.groupBy);

  return params;
}

/** Esc clears selection ids only — keep tab / filters / time window. */
export function clearCostSelection(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  writeId(next, "budgetId", undefined);
  return next;
}

export function costSearchParamsEqual(
  a: URLSearchParams,
  b: URLSearchParams,
): boolean {
  return a.toString() === b.toString();
}

export function costQueryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
