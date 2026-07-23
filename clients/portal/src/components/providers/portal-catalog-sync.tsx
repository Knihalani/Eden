"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { api } from "@/lib/api/resources";
import {
  clearPortalCatalog,
  patchPortalCatalog,
} from "@/lib/portal-catalog";

// Must match the ``cost/page.tsx`` budget query exactly so this
// prefetch lands in the same React Query cache entry.
const BUDGET_QUERY_KEY = (orgId: string | null) =>
  queryKey("cost", orgId, "budget");

const OBSERVE_STALE = 45_000;
const SETTINGS_STALE = 60_000;
const ASSIST_STALE = 10_000;

const SHELL_QUERY = {
  staleTime: OBSERVE_STALE,
  refetchOnWindowFocus: false as const,
};

function pathIn(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Prefetch portal read models for the active org and mirror into
 * ``portal-catalog`` so fixture helpers resolve live rows.
 *
 * Shell-light always: agents / issues / signals / alerts.
 * Heavy lists (traces, sessions) only on Observe-ish routes — cuts
 * parallel GETs on Settings / Evals / Assist mounts.
 */
export function PortalCatalogSync() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const pathname = usePathname() ?? "";

  const onSettings = pathIn(pathname, ["/settings"]);
  const onEvals = pathIn(pathname, ["/evals"]);
  const onCompare = pathIn(pathname, ["/compare"]);
  const onImprove = pathIn(pathname, ["/improve"]);
  const onGuardrails = pathIn(pathname, ["/guardrails"]);
  const onDebugger = pathIn(pathname, ["/debugger"]);
  const onAgent = pathIn(pathname, ["/agent"]);
  const onCost = pathIn(pathname, ["/cost"]);
  /** Traces only on /home — skip sessions/cost/improve prefetch. */
  const onHomeTraces = pathIn(pathname, ["/home"]);
  const onObserveHeavy = pathIn(pathname, [
    "/traces",
    "/sessions",
    "/issues",
    "/signals",
    "/alerts",
    "/agents",
    "/debugger",
  ]);
  const onTraces = onObserveHeavy || onHomeTraces;

  useEffect(() => {
    if (!orgId) {
      clearPortalCatalog();
      return;
    }
    patchPortalCatalog({ orgId });
  }, [orgId]);

  // ── Always (shell-light) ──
  const agents = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    SHELL_QUERY,
  );
  const traces = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    { ...SHELL_QUERY, enabled: onTraces },
  );
  const sessions = useOrgQuery(
    queryKeys.portal.sessions(orgId),
    orgId,
    () => portalApi.sessions(orgId!),
    { ...SHELL_QUERY, enabled: onObserveHeavy },
  );
  /** Home + Observe-heavy — Issue/Run badges on Home need this too.
   * Defer on Home until agents settle so cold-start bandwidth goes to
   * agents/traces first (issues still hydrate from SSR when present). */
  const issues = useOrgQuery(
    queryKeys.portal.issues(orgId),
    orgId,
    () => portalApi.issues(orgId!),
    {
      ...SHELL_QUERY,
      enabled:
        onObserveHeavy ||
        (onHomeTraces && !agents.isPending),
    },
  );
  const signals = useOrgQuery(
    queryKeys.portal.signals(orgId),
    orgId,
    () => portalApi.signals(orgId!),
    { ...SHELL_QUERY, enabled: onObserveHeavy },
  );
  const alertRules = useOrgQuery(
    queryKeys.portal.alertRules(orgId),
    orgId,
    () => portalApi.alertRules(orgId!),
    { ...SHELL_QUERY, enabled: onObserveHeavy },
  );
  /**
   * Alerts bell needs this everywhere, but on Home it competes with
   * agents/traces for the same cold-start bandwidth. Defer until
   * agents settles (or we're not on Home at all) so Home's own
   * shards win the race. High staleTime is fine — the bell is not
   * time-critical to the second.
   */
  const alertEvents = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    {
      ...SHELL_QUERY,
      staleTime: 60_000,
      enabled: !onHomeTraces || !agents.isPending,
    },
  );
  const costDrivers = useOrgQuery(
    queryKeys.portal.costDrivers(orgId),
    orgId,
    () => portalApi.costDrivers(orgId!),
    { ...SHELL_QUERY, enabled: onCost },
  );
  // Prefetches into the same cache entry the Cost page reads via
  // ``api.getBudget`` — by the time it mounts, budget is already warm.
  useOrgQuery(
    BUDGET_QUERY_KEY(orgId),
    orgId,
    () => api.getBudget(orgId!),
    { ...SHELL_QUERY, enabled: onCost },
  );

  // ── Route-scoped ──
  const improvePlans = useOrgQuery(
    queryKeys.portal.improvePlans(orgId),
    orgId,
    () => portalApi.improvePlans(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onImprove },
  );
  const compareExperiments = useOrgQuery(
    queryKeys.portal.compareExperiments(orgId),
    orgId,
    () => portalApi.compareExperiments(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onCompare },
  );
  const guardrailPolicies = useOrgQuery(
    queryKeys.portal.guardrailPolicies(orgId),
    orgId,
    () => portalApi.guardrailPolicies(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onGuardrails },
  );
  const datasets = useOrgQuery(
    queryKeys.portal.evalDatasets(orgId),
    orgId,
    () => portalApi.evalDatasets(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onEvals },
  );
  const playgrounds = useOrgQuery(
    queryKeys.portal.evalPlaygrounds(orgId),
    orgId,
    () => portalApi.evalPlaygrounds(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onEvals },
  );
  const experiments = useOrgQuery(
    queryKeys.portal.evalExperiments(orgId),
    orgId,
    () => portalApi.evalExperiments(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onEvals },
  );
  const debuggerSessions = useOrgQuery(
    queryKeys.portal.debuggerSessions(orgId),
    orgId,
    () => portalApi.debuggerSessions(orgId!),
    { staleTime: ASSIST_STALE, enabled: onDebugger },
  );
  const assistantThreads = useOrgQuery(
    queryKeys.portal.assistantThreads(orgId),
    orgId,
    () => portalApi.assistantThreads(orgId!),
    { staleTime: ASSIST_STALE, enabled: onAgent },
  );
  const workspace = useOrgQuery(
    queryKeys.portal.workspace(orgId),
    orgId,
    () => portalApi.workspace(orgId!),
    {
      staleTime: SETTINGS_STALE,
      refetchOnWindowFocus: false,
      enabled: onSettings,
    },
  );
  const keys = useOrgQuery(
    queryKeys.portal.keys(orgId),
    orgId,
    () => portalApi.keys(orgId!),
    {
      staleTime: SETTINGS_STALE,
      refetchOnWindowFocus: false,
      enabled: onSettings,
    },
  );
  const members = useOrgQuery(
    queryKeys.portal.members(orgId),
    orgId,
    () => portalApi.members(orgId!),
    {
      staleTime: SETTINGS_STALE,
      refetchOnWindowFocus: false,
      enabled: onSettings,
    },
  );
  const auditEvents = useOrgQuery(
    queryKeys.portal.auditEvents(orgId),
    orgId,
    () => portalApi.auditEvents(orgId!),
    {
      staleTime: SETTINGS_STALE,
      refetchOnWindowFocus: false,
      enabled: onSettings,
    },
  );
  const auditPacks = useOrgQuery(
    queryKeys.portal.auditPacks(orgId),
    orgId,
    () => portalApi.auditPacks(orgId!),
    {
      staleTime: SETTINGS_STALE,
      refetchOnWindowFocus: false,
      enabled: onSettings,
    },
  );

  useEffect(() => {
    patchPortalCatalog({
      agents: agents.data ?? [],
      traces: traces.data ?? [],
      sessions: sessions.data ?? [],
      issues: issues.data ?? [],
      signals: signals.data ?? [],
      alertRules: alertRules.data ?? [],
      alertEvents: alertEvents.data ?? [],
      ...(costDrivers.data !== undefined
        ? { costDrivers: costDrivers.data }
        : {}),
      ...(improvePlans.data !== undefined
        ? { improvePlans: improvePlans.data }
        : {}),
      ...(compareExperiments.data !== undefined
        ? { compareExperiments: compareExperiments.data }
        : {}),
      ...(guardrailPolicies.data !== undefined
        ? { guardrailPolicies: guardrailPolicies.data }
        : {}),
      ...(datasets.data !== undefined ? { datasets: datasets.data } : {}),
      ...(playgrounds.data !== undefined
        ? { playgrounds: playgrounds.data }
        : {}),
      ...(experiments.data !== undefined
        ? { experiments: experiments.data }
        : {}),
      ...(debuggerSessions.data !== undefined
        ? { debuggerSessions: debuggerSessions.data }
        : {}),
      ...(assistantThreads.data !== undefined
        ? { assistantThreads: assistantThreads.data }
        : {}),
      ...(workspace.data !== undefined
        ? { workspace: workspace.data }
        : {}),
      ...(keys.data !== undefined ? { keys: keys.data } : {}),
      ...(members.data !== undefined ? { members: members.data } : {}),
      ...(auditEvents.data !== undefined
        ? { auditEvents: auditEvents.data }
        : {}),
      ...(auditPacks.data !== undefined
        ? { auditPacks: auditPacks.data }
        : {}),
    });
  }, [
    agents.data,
    traces.data,
    sessions.data,
    issues.data,
    signals.data,
    alertRules.data,
    alertEvents.data,
    costDrivers.data,
    improvePlans.data,
    compareExperiments.data,
    guardrailPolicies.data,
    datasets.data,
    playgrounds.data,
    experiments.data,
    debuggerSessions.data,
    assistantThreads.data,
    workspace.data,
    keys.data,
    members.data,
    auditEvents.data,
    auditPacks.data,
  ]);

  return null;
}

export {
  OBSERVE_STALE,
  SETTINGS_STALE,
  ASSIST_STALE,
};
