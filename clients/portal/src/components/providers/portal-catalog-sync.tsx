"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import {
  clearPortalCatalog,
  patchPortalCatalog,
} from "@/lib/portal-catalog";

const OBSERVE_STALE = 20_000;
const SETTINGS_STALE = 60_000;
const ASSIST_STALE = 10_000;

function pathIn(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Prefetch portal read models for the active org and mirror into
 * ``portal-catalog`` so fixture helpers resolve live rows.
 *
 * Always warms Observe + alerts (Home / shell). Secondary domains
 * fetch only when the user is on a matching route — avoids 20 GETs
 * on every page mount while still sharing RQ cache with leaf pages.
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
  const onCost = pathIn(pathname, ["/cost", "/home"]);

  useEffect(() => {
    if (!orgId) {
      clearPortalCatalog();
      return;
    }
    patchPortalCatalog({ orgId });
  }, [orgId]);

  // ── Always: Observe + alerts (Home / sidebar / cross-links) ──
  const agents = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const traces = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const sessions = useOrgQuery(
    queryKeys.portal.sessions(orgId),
    orgId,
    () => portalApi.sessions(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const issues = useOrgQuery(
    queryKeys.portal.issues(orgId),
    orgId,
    () => portalApi.issues(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const signals = useOrgQuery(
    queryKeys.portal.signals(orgId),
    orgId,
    () => portalApi.signals(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const alertRules = useOrgQuery(
    queryKeys.portal.alertRules(orgId),
    orgId,
    () => portalApi.alertRules(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const alertEvents = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    { staleTime: OBSERVE_STALE },
  );
  const costDrivers = useOrgQuery(
    queryKeys.portal.costDrivers(orgId),
    orgId,
    () => portalApi.costDrivers(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onCost },
  );

  // ── Route-scoped ──
  const improvePlans = useOrgQuery(
    queryKeys.portal.improvePlans(orgId),
    orgId,
    () => portalApi.improvePlans(orgId!),
    { staleTime: OBSERVE_STALE, enabled: onImprove || pathIn(pathname, ["/home"]) },
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
