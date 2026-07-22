/**
 * Evals hub URL grammar — parse / normalize / write (surfaces/evals.md §3).
 */

export const EVALS_TABS = [
  "datasets",
  "playgrounds",
  "experiments",
  "labeling",
  "studio",
  "synthetic",
  "eval",
] as const;
export type EvalsTab = (typeof EVALS_TABS)[number];

export const EVALS_PRIMARY_TABS = [
  "datasets",
  "playgrounds",
  "experiments",
] as const;
export type EvalsPrimaryTab = (typeof EVALS_PRIMARY_TABS)[number];

export const EVALS_ADVANCED_TABS = [
  "labeling",
  "studio",
  "synthetic",
  "eval",
] as const;
export type EvalsAdvancedTab = (typeof EVALS_ADVANCED_TABS)[number];

export const EVALS_COMPARE_LAYOUTS = ["summary", "list", "grid"] as const;
export type EvalsCompareLayout = (typeof EVALS_COMPARE_LAYOUTS)[number];

export const EVALS_GRADES = ["improve", "regress", "tradeoff", "tie"] as const;
export type EvalsGrade = (typeof EVALS_GRADES)[number];

export type EvalsUrlState = {
  tab: EvalsTab;
  datasetId?: string;
  playgroundId?: string;
  experimentId?: string;
  baselineId?: string;
  compareId?: string;
  layout?: EvalsCompareLayout;
  diff?: "0" | "1";
  grade?: EvalsGrade;
  agentId?: string;
  q?: string;
  filter?: string;
  queueId?: string;
  viewId?: string;
  /** Promote-from-trace handoff. */
  traceId?: string;
  spanId?: string;
};

const DEFAULT_TAB: EvalsTab = "datasets";
const DEFAULT_LAYOUT: EvalsCompareLayout = "summary";

const ID_ALIASES = {
  datasetId: ["datasetId", "dataset_id"],
  playgroundId: ["playgroundId", "playground_id"],
  experimentId: ["experimentId", "experiment_id"],
  baselineId: ["baselineId", "baseline_id"],
  compareId: ["compareId", "compare_id"],
  agentId: ["agentId", "agent_id"],
  queueId: ["queueId", "queue_id"],
  viewId: ["viewId", "savedView"],
  traceId: ["traceId", "trace_id", "promote_trace"],
  spanId: ["spanId", "span_id"],
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

export function parseEvalsTab(raw: string | null | undefined): EvalsTab {
  if (isIn(raw, EVALS_TABS)) return raw;
  return DEFAULT_TAB;
}

export function parseEvalsSearchParams(params: URLSearchParams): EvalsUrlState {
  const layoutRaw = params.get("layout");
  const diffRaw = params.get("diff");
  const gradeRaw = params.get("grade");

  return {
    tab: parseEvalsTab(params.get("tab")),
    datasetId: readId(params, "datasetId"),
    playgroundId: readId(params, "playgroundId"),
    experimentId: readId(params, "experimentId"),
    baselineId: readId(params, "baselineId"),
    compareId: readId(params, "compareId"),
    layout: isIn(layoutRaw, EVALS_COMPARE_LAYOUTS) ? layoutRaw : undefined,
    diff: diffRaw === "1" || diffRaw === "0" ? diffRaw : undefined,
    grade: isIn(gradeRaw, EVALS_GRADES) ? gradeRaw : undefined,
    agentId: readId(params, "agentId"),
    q: params.get("q") || undefined,
    filter: params.get("filter") || undefined,
    queueId: readId(params, "queueId"),
    viewId: readId(params, "viewId"),
    traceId: readId(params, "traceId"),
    spanId: readId(params, "spanId"),
  };
}

/** Alias → camelCase normalize; drop empties of known aliases. */
export function normalizeEvalsSearchParams(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const kind of Object.keys(ID_ALIASES) as IdKey[]) {
    writeId(next, kind, readId(next, kind));
  }
  const tab = parseEvalsTab(next.get("tab"));
  if (tab === DEFAULT_TAB) next.delete("tab");
  else next.set("tab", tab);

  const layout = next.get("layout");
  if (layout && !isIn(layout, EVALS_COMPARE_LAYOUTS)) next.delete("layout");
  if (layout === DEFAULT_LAYOUT) next.delete("layout");

  const grade = next.get("grade");
  if (grade && !isIn(grade, EVALS_GRADES)) next.delete("grade");

  const diff = next.get("diff");
  if (diff === "0") next.delete("diff");
  else if (diff && diff !== "1") next.delete("diff");

  return next;
}

export function writeEvalsSearchParams(
  patch: Partial<EvalsUrlState>,
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

  if ("datasetId" in patch) writeId(params, "datasetId", patch.datasetId);
  if ("playgroundId" in patch) writeId(params, "playgroundId", patch.playgroundId);
  if ("experimentId" in patch) writeId(params, "experimentId", patch.experimentId);
  if ("baselineId" in patch) writeId(params, "baselineId", patch.baselineId);
  if ("compareId" in patch) writeId(params, "compareId", patch.compareId);
  if ("agentId" in patch) writeId(params, "agentId", patch.agentId);
  if ("queueId" in patch) writeId(params, "queueId", patch.queueId);
  if ("viewId" in patch) writeId(params, "viewId", patch.viewId);
  if ("traceId" in patch) writeId(params, "traceId", patch.traceId);
  if ("spanId" in patch) writeId(params, "spanId", patch.spanId);

  if ("layout" in patch) {
    if (!patch.layout || patch.layout === DEFAULT_LAYOUT) params.delete("layout");
    else params.set("layout", patch.layout);
  }
  if ("diff" in patch) {
    if (!patch.diff || patch.diff === "0") params.delete("diff");
    else params.set("diff", "1");
  }
  if ("grade" in patch) setOrDelete("grade", patch.grade);
  if ("q" in patch) setOrDelete("q", patch.q);
  if ("filter" in patch) setOrDelete("filter", patch.filter);

  return params;
}

/** Esc clears selection ids only — keep tab / filters / compare chrome. */
export function clearEvalsSelection(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  writeId(next, "datasetId", undefined);
  writeId(next, "playgroundId", undefined);
  writeId(next, "experimentId", undefined);
  writeId(next, "queueId", undefined);
  writeId(next, "traceId", undefined);
  writeId(next, "spanId", undefined);
  return next;
}

export function evalsSearchParamsEqual(
  a: URLSearchParams,
  b: URLSearchParams,
): boolean {
  return a.toString() === b.toString();
}

export function evalsQueryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function isEvalsPrimaryTab(tab: EvalsTab): tab is EvalsPrimaryTab {
  return (EVALS_PRIMARY_TABS as readonly string[]).includes(tab);
}

export function isEvalsAdvancedTab(tab: EvalsTab): tab is EvalsAdvancedTab {
  return (EVALS_ADVANCED_TABS as readonly string[]).includes(tab);
}
