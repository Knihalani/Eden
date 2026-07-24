"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { api } from "@/lib/api/resources";
import {
  clearPortalCatalog,
  patchPortalCatalog,
} from "@/lib/portal-catalog";
import {
  ASSIST_STALE,
  OBSERVE_STALE,
  SETTINGS_QUERY,
  SETTINGS_STALE,
  SHELL_QUERY,
} from "@/lib/portal-query";
import {
  parseSettingsMode,
  resolveSettingsModeParam,
} from "@/lab/settings/settings-chrome";

// Must match the ``cost/page.tsx`` budget query exactly so this
// prefetch lands in the same React Query cache entry.
const BUDGET_QUERY_KEY = (orgId: string | null) =>
  queryKey("cost", orgId, "budget");

function pathIn(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Prefetch portal read models for the active org and mirror into
 * ``portal-catalog`` so fixture helpers resolve live rows.
 *
 * Route-scoped: only fetch shards the current page actually renders.
 */
export function PortalCatalogSync() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();

  const onHome = pathIn(pathname, ["/home"]);
  const onTraces = pathIn(pathname, ["/traces"]);
  const onSessions = pathIn(pathname, ["/sessions"]);
  const onIssues = pathIn(pathname, ["/issues"]);
  const onSignals = pathIn(pathname, ["/signals"]);
  const onAlerts = pathIn(pathname, ["/alerts"]);
  const onAgents = pathIn(pathname, ["/agents"]);
  const onDebugger = pathIn(pathname, ["/debugger"]);
  const onSettings = pathIn(pathname, ["/settings"]);
  const onEvals = pathIn(pathname, ["/evals"]);
  const onCompare = pathIn(pathname, ["/compare"]);
  const onImprove = pathIn(pathname, ["/improve"]);
  const onGuardrails = pathIn(pathname, ["/guardrails"]);
  const onAgent = pathIn(pathname, ["/agent"]);
  const onCost = pathIn(pathname, ["/cost"]);

  const settingsMode = onSettings
    ? parseSettingsMode(
        resolveSettingsModeParam(
          searchParams.get("mode"),
          searchParams.get("tab"),
        ),
      )
    : null;

  const needAgents =
    onHome ||
    onTraces ||
    onSessions ||
    onIssues ||
    onSignals ||
    onAlerts ||
    onAgents ||
    onDebugger ||
    onEvals ||
    onCompare ||
    onImprove ||
    onGuardrails ||
    onCost;
  const needTraces =
    onHome || onTraces || onAgents || onDebugger || onSessions;
  const needSessions = onTraces || onSessions || onAgents;
  // Issues: home + issues page only (traces badges soft-miss until cached).
  const needIssues = onHome || onIssues;
  const needSignals = onSignals;
  const needAlertRules = onAlerts || onSignals;
  // Bell badge — defer until agents settle when agents are loading;
  // longer TTL so soft-nav does not re-hit events constantly.
  const needAlertEvents = true;

  useEffect(() => {
    if (!orgId) {
      clearPortalCatalog();
      return;
    }
    patchPortalCatalog({ orgId });
  }, [orgId]);

  const agents = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    { ...SHELL_QUERY, enabled: needAgents },
  );
  const traces = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    { ...SHELL_QUERY, enabled: needTraces },
  );
  const sessions = useOrgQuery(
    queryKeys.portal.sessions(orgId),
    orgId,
    () => portalApi.sessions(orgId!),
    { ...SHELL_QUERY, enabled: needSessions },
  );
  const issues = useOrgQuery(
    queryKeys.portal.issues(orgId),
    orgId,
    () => portalApi.issues(orgId!),
    {
      ...SHELL_QUERY,
      enabled: needIssues && (!onHome || !agents.isPending),
    },
  );
  const signals = useOrgQuery(
    queryKeys.portal.signals(orgId),
    orgId,
    () => portalApi.signals(orgId!),
    { ...SHELL_QUERY, enabled: needSignals },
  );
  const alertRules = useOrgQuery(
    queryKeys.portal.alertRules(orgId),
    orgId,
    () => portalApi.alertRules(orgId!),
    { ...SHELL_QUERY, enabled: needAlertRules },
  );
  // Bell badge — always; on routes that load agents, wait until agents
  // settle so cold start isn't competing with above-the-fold shards.
  const alertEvents = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    {
      ...SHELL_QUERY,
      staleTime: 120_000,
      enabled: needAlertEvents && (needAgents ? !agents.isPending : true),
    },
  );
  const costDrivers = useOrgQuery(
    queryKeys.portal.costDrivers(orgId),
    orgId,
    () => portalApi.costDrivers(orgId!),
    { ...SHELL_QUERY, enabled: onCost },
  );
  useOrgQuery(
    BUDGET_QUERY_KEY(orgId),
    orgId,
    () => api.getBudget(orgId!),
    { ...SHELL_QUERY, enabled: onCost },
  );

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

  // Settings — workspace always (header meta); other shards by mode.
  const workspace = useOrgQuery(
    queryKeys.portal.workspace(orgId),
    orgId,
    () => portalApi.workspace(orgId!),
    { ...SETTINGS_QUERY, enabled: onSettings },
  );
  const keys = useOrgQuery(
    queryKeys.portal.keys(orgId),
    orgId,
    () => portalApi.keys(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: onSettings && settingsMode === "keys",
    },
  );
  const members = useOrgQuery(
    queryKeys.portal.members(orgId),
    orgId,
    () => portalApi.members(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: onSettings && settingsMode === "members",
    },
  );
  const auditEvents = useOrgQuery(
    queryKeys.portal.auditEvents(orgId),
    orgId,
    () => portalApi.auditEvents(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: onSettings && settingsMode === "audit",
    },
  );
  const auditPacks = useOrgQuery(
    queryKeys.portal.auditPacks(orgId),
    orgId,
    () => portalApi.auditPacks(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: onSettings && settingsMode === "audit",
    },
  );

  useEffect(() => {
    patchPortalCatalog({
      ...(agents.data !== undefined ? { agents: agents.data } : {}),
      ...(traces.data !== undefined ? { traces: traces.data } : {}),
      ...(sessions.data !== undefined ? { sessions: sessions.data } : {}),
      ...(issues.data !== undefined ? { issues: issues.data } : {}),
      ...(signals.data !== undefined ? { signals: signals.data } : {}),
      ...(alertRules.data !== undefined ? { alertRules: alertRules.data } : {}),
      ...(alertEvents.data !== undefined
        ? { alertEvents: alertEvents.data }
        : {}),
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
  SHELL_QUERY,
  SETTINGS_QUERY,
};
