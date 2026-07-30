"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey, queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { budgetApi } from "@/lib/api/budget";
import {
  clearPortalCatalog,
  patchPortalCatalog,
} from "@/lib/portal-catalog";
import {
  OBSERVE_STALE,
  SHELL_QUERY,
} from "@/lib/portal-query";

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
 * Peripheral hubs (evals/cost/improve/…) load agents themselves when
 * their scope filter needs them — do not warm agents/traces here.
 * Settings / debugger / agent-chat fetch their own shards in-page.
 */
export function PortalCatalogSync() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const pathname = usePathname() ?? "";

  const onHome = pathIn(pathname, ["/home"]);
  const onTraces = pathIn(pathname, ["/traces"]);
  const onSessions = pathIn(pathname, ["/sessions"]);
  const onIssues = pathIn(pathname, ["/issues"]);
  const onSignals = pathIn(pathname, ["/signals"]);
  const onAlerts = pathIn(pathname, ["/alerts"]);
  const onAgents = pathIn(pathname, ["/agents"]);
  const onDebugger = pathIn(pathname, ["/debugger"]);
  const onEvals = pathIn(pathname, ["/evals"]);
  const onCompare = pathIn(pathname, ["/compare"]);
  const onImprove = pathIn(pathname, ["/improve"]);
  const onGuardrails = pathIn(pathname, ["/guardrails"]);
  const onCost = pathIn(pathname, ["/cost"]);

  // Agents: only observe hubs that render agent lists / scope chips
  // from the catalog. Cost/evals/improve fetch agents in-page when needed.
  // Settings / agent-chat / debugger fetch their own shards — do not warm here.
  const needAgents =
    onHome ||
    onTraces ||
    onSessions ||
    onIssues ||
    onSignals ||
    onAlerts ||
    onAgents ||
    onDebugger;
  const needTraces = onHome || onTraces || onAgents || onDebugger || onSessions;
  // Sessions are traces-hub only (agents inspector uses traces, not sessions).
  const needSessions = onTraces || onSessions;
  const needIssues = onHome || onIssues || onTraces;
  const needSignals = onSignals;
  // Alert rules: alerts modal / alerts route only (signals page does not read them).
  const needAlertRules = onAlerts;

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
  const costDrivers = useOrgQuery(
    queryKeys.portal.costDrivers(orgId),
    orgId,
    () => portalApi.costDrivers(orgId!),
    { ...SHELL_QUERY, enabled: onCost },
  );
  useOrgQuery(
    BUDGET_QUERY_KEY(orgId),
    orgId,
    () => budgetApi.get(orgId!),
    { ...SHELL_QUERY, enabled: onCost },
  );

  const improvePlans = useOrgQuery(
    queryKeys.portal.improvePlans(orgId),
    orgId,
    () => portalApi.improvePlans(orgId!),
    { ...SHELL_QUERY, staleTime: OBSERVE_STALE, enabled: onImprove },
  );
  const compareExperiments = useOrgQuery(
    queryKeys.portal.compareExperiments(orgId),
    orgId,
    () => portalApi.compareExperiments(orgId!),
    { ...SHELL_QUERY, staleTime: OBSERVE_STALE, enabled: onCompare },
  );
  const guardrailPolicies = useOrgQuery(
    queryKeys.portal.guardrailPolicies(orgId),
    orgId,
    () => portalApi.guardrailPolicies(orgId!),
    { ...SHELL_QUERY, staleTime: OBSERVE_STALE, enabled: onGuardrails },
  );
  const datasets = useOrgQuery(
    queryKeys.portal.evalDatasets(orgId),
    orgId,
    () => portalApi.evalDatasets(orgId!),
    { ...SHELL_QUERY, staleTime: OBSERVE_STALE, enabled: onEvals },
  );
  const playgrounds = useOrgQuery(
    queryKeys.portal.evalPlaygrounds(orgId),
    orgId,
    () => portalApi.evalPlaygrounds(orgId!),
    { ...SHELL_QUERY, staleTime: OBSERVE_STALE, enabled: onEvals },
  );
  const experiments = useOrgQuery(
    queryKeys.portal.evalExperiments(orgId),
    orgId,
    () => portalApi.evalExperiments(orgId!),
    { ...SHELL_QUERY, staleTime: OBSERVE_STALE, enabled: onEvals },
  );

  useEffect(() => {
    patchPortalCatalog({
      ...(agents.data !== undefined ? { agents: agents.data } : {}),
      ...(traces.data !== undefined ? { traces: traces.data } : {}),
      ...(sessions.data !== undefined ? { sessions: sessions.data } : {}),
      ...(issues.data !== undefined ? { issues: issues.data } : {}),
      ...(signals.data !== undefined ? { signals: signals.data } : {}),
      ...(alertRules.data !== undefined ? { alertRules: alertRules.data } : {}),
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
    });
  }, [
    agents.data,
    traces.data,
    sessions.data,
    issues.data,
    signals.data,
    alertRules.data,
    costDrivers.data,
    improvePlans.data,
    compareExperiments.data,
    guardrailPolicies.data,
    datasets.data,
    playgrounds.data,
    experiments.data,
  ]);

  return null;
}

export {
  ASSIST_STALE,
  OBSERVE_STALE,
  SETTINGS_QUERY,
  SETTINGS_STALE,
  SHELL_QUERY,
} from "@/lib/portal-query";
