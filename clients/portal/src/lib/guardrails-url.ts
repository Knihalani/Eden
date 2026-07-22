/**
 * Guardrails hub URL grammar — parse / normalize / write (surfaces/guardrails.md §3).
 * `tab=redteam` normalizes to `policies` (kill-list).
 */

export const GUARDRAILS_TABS = ["policies", "violations"] as const;
export type GuardrailsTab = (typeof GUARDRAILS_TABS)[number];

export const GUARDRAILS_SEVERITIES = ["block", "warn", "log"] as const;
export type GuardrailsSeverity = (typeof GUARDRAILS_SEVERITIES)[number];

export type GuardrailsUrlState = {
  tab: GuardrailsTab;
  policyId?: string;
  violationId?: string;
  agentId?: string;
  q?: string;
  filter?: string;
  viewId?: string;
  pastHours?: string;
  from?: string;
  to?: string;
  severity?: GuardrailsSeverity;
};

const DEFAULT_TAB: GuardrailsTab = "policies";

const ID_ALIASES = {
  policyId: ["policyId", "policy_id"],
  violationId: ["violationId", "violation_id"],
  agentId: ["agentId", "agent_id"],
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

/** Illegal `redteam` (and unknowns) map to default policies. */
export function parseGuardrailsTab(
  raw: string | null | undefined,
): GuardrailsTab {
  if (isIn(raw, GUARDRAILS_TABS)) return raw;
  return DEFAULT_TAB;
}

export function parseGuardrailsSearchParams(
  params: URLSearchParams,
): GuardrailsUrlState {
  const severityRaw = params.get("severity");

  return {
    tab: parseGuardrailsTab(params.get("tab")),
    policyId: readId(params, "policyId"),
    violationId: readId(params, "violationId"),
    agentId: readId(params, "agentId"),
    q: params.get("q") || undefined,
    filter: params.get("filter") || undefined,
    viewId: readId(params, "viewId"),
    pastHours: params.get("pastHours") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    severity: isIn(severityRaw, GUARDRAILS_SEVERITIES)
      ? severityRaw
      : undefined,
  };
}

/** Alias → camelCase normalize; `tab=redteam` → policies (stripped when default). */
export function normalizeGuardrailsSearchParams(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const kind of Object.keys(ID_ALIASES) as IdKey[]) {
    writeId(next, kind, readId(next, kind));
  }
  const tab = parseGuardrailsTab(next.get("tab"));
  if (tab === DEFAULT_TAB) next.delete("tab");
  else next.set("tab", tab);

  const severity = next.get("severity");
  if (severity && !isIn(severity, GUARDRAILS_SEVERITIES)) {
    next.delete("severity");
  }

  return next;
}

export function writeGuardrailsSearchParams(
  patch: Partial<GuardrailsUrlState>,
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

  if ("policyId" in patch) writeId(params, "policyId", patch.policyId);
  if ("violationId" in patch)
    writeId(params, "violationId", patch.violationId);
  if ("agentId" in patch) writeId(params, "agentId", patch.agentId);
  if ("viewId" in patch) writeId(params, "viewId", patch.viewId);

  if ("q" in patch) setOrDelete("q", patch.q);
  if ("filter" in patch) setOrDelete("filter", patch.filter);
  if ("pastHours" in patch) setOrDelete("pastHours", patch.pastHours);
  if ("from" in patch) setOrDelete("from", patch.from);
  if ("to" in patch) setOrDelete("to", patch.to);
  if ("severity" in patch) setOrDelete("severity", patch.severity);

  return params;
}

/** Esc clears selection ids only — keep tab / filters / time window. */
export function clearGuardrailsSelection(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  writeId(next, "policyId", undefined);
  writeId(next, "violationId", undefined);
  return next;
}

export function guardrailsSearchParamsEqual(
  a: URLSearchParams,
  b: URLSearchParams,
): boolean {
  return a.toString() === b.toString();
}

export function guardrailsQueryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
