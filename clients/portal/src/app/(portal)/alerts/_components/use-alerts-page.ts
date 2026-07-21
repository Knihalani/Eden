"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useQueryTab } from "@/hooks/use-query-tab";
import { useToast } from "@/components/ui/toast";
import { api, integrationsApi } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useResourceUrlState } from "@/components/portal-os";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import {
  ALERT_TABS,
  BASE_CHANNEL_CONFIGURED,
  type AlertItem,
  type SeverityFilter,
  type VerdictFilter,
} from "./alert-config";

export function useAlertsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentOrg, orgSyncing } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const [tab, setTab] = useQueryTab("tab", ALERT_TABS, "feed");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<boolean | null>(
    null,
  );
  const [selectedAlerts, setSelectedAlerts] = useState<Set<string>>(new Set());
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const alertId = urlState.alertId;
  const [offset, setOffset] = useState(0);
  // Rules is a feed-panel toggle (?tab=rules), not a hub peer of Feed/Signals.
  const [rulesOpen, setRulesOpen] = useState(
    searchParams.get("tab") === "rules",
  );
  const showSignals = tab === "signals";
  const [channelConfigured, setChannelConfigured] = useState(
    BASE_CHANNEL_CONFIGURED,
  );
  const limit = 50;

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    integrationsApi
      .getSlackSettings(orgId)
      .then((slack) => {
        if (cancelled) return;
        setChannelConfigured((prev) => ({
          ...prev,
          slack: Boolean(slack.configured && slack.enabled),
        }));
      })
      .catch(() => {
        if (!cancelled) setChannelConfigured(BASE_CHANNEL_CONFIGURED);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const alertsParams: {
    severity?: string;
    acknowledged?: boolean;
    limit: number;
    offset: number;
  } = {
    limit,
    offset,
    ...(severityFilter !== "all" ? { severity: severityFilter } : {}),
    ...(acknowledgedFilter !== null ? { acknowledged: acknowledgedFilter } : {}),
  };

  const alertsQuery = useOrgQuery(
    queryKeys.alerts.list(orgId, alertsParams),
    orgId,
    () => api.listAlerts(orgId!, alertsParams),
    {
      refetchInterval: 30_000,
      enabled: !orgSyncing && !showSignals && !rulesOpen,
    },
  );
  const rulesQuery = useOrgQuery(
    queryKeys.alerts.nlRules(orgId),
    orgId,
    () => api.listNlAlertRules(orgId!),
    { enabled: !orgSyncing },
  );
  const hasAlertRules = (rulesQuery.data?.rules?.length ?? 0) > 0;
  const rulesReady =
    !rulesQuery.isLoading && !rulesQuery.isPending && !rulesQuery.isError;
  const rulesError = rulesQuery.error?.message ?? null;
  const loading = alertsQuery.isLoading;
  const refreshing = alertsQuery.isFetching && !loading;
  const total = alertsQuery.data?.total ?? 0;
  const unreadCount = alertsQuery.data?.unread_count ?? 0;

  const alerts: AlertItem[] = (alertsQuery.data?.alerts ?? []).map((a) => ({
    alert_id: a.alert_id,
    title: a.title,
    description: a.description,
    source: a.source,
    message: a.description,
    severity: a.severity,
    entity_id: a.entity_id ?? a.source ?? "",
    acknowledged: a.acknowledged,
    triggered_at: a.triggered_at,
    created_at: a.triggered_at,
    acknowledged_at: a.acknowledged_at,
    acknowledged_by: a.acknowledged_by,
    channels: a.channels ?? [],
    metadata: a.metadata,
  }));

  const eventsParams = useMemo(
    () => ({
      ...(verdictFilter !== "all" ? { verdict: verdictFilter } : {}),
      limit,
      // Triage feed is independent of alert-list pagination.
      offset: 0,
    }),
    [verdictFilter, limit],
  );
  const eventsQuery = useOrgQuery(
    queryKeys.alerts.events(orgId, eventsParams),
    orgId,
    () => api.listAlertEvents(orgId!, eventsParams),
    { enabled: !orgSyncing && !showSignals && !rulesOpen },
  );
  const triageEvents = eventsQuery.data?.events ?? [];

  const fetchAlerts = () => void alertsQuery.refetch();

  const ackMutation = useOrgMutation(
    (id: string) => api.acknowledgeAlert(orgId!, id),
    { invalidateKeys: [queryKeys.alerts.list(orgId)] },
  );
  const batchAckMutation = useOrgMutation(
    (ids: string[]) => api.acknowledgeAlertsBatch(orgId!, ids),
    { invalidateKeys: [queryKeys.alerts.list(orgId)] },
  );
  const ackLoading = batchAckMutation.isPending;

  const handleAcknowledge = async (id: string) => {
    if (!orgId) return;
    try {
      await ackMutation.mutateAsync(id);
      toast.success("Alert acknowledged");
    } catch (e) {
      toast.error(
        "Could not acknowledge alert",
        e instanceof Error ? e.message : undefined,
      );
    }
  };

  const handleBatchAcknowledge = async () => {
    const ids = Array.from(selectedAlerts);
    if (ids.length === 0 || !orgId) return;
    try {
      await batchAckMutation.mutateAsync(ids);
      setSelectedAlerts(new Set());
      toast.success(
        `Acknowledged ${ids.length} alert${ids.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(
        "Batch acknowledge failed",
        e instanceof Error ? e.message : undefined,
      );
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedAlerts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const severityCounts = alerts.reduce(
    (acc, a) => {
      acc[a.severity] = (acc[a.severity] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const hasSelection = selectedAlerts.size > 0;
  const selectedAlert = alertId
    ? (alerts.find((a) => a.alert_id === alertId) ?? null)
    : null;
  const alertIndex = alertId
    ? alerts.findIndex((a) => a.alert_id === alertId)
    : -1;

  useListKeyboardNav(
    alerts.length,
    alertIndex >= 0 ? alertIndex : 0,
    (idx) => {
      const row = alerts[idx];
      if (row) setUrlState({ alertId: row.alert_id });
    },
    tab === "feed" && !rulesOpen && alerts.length > 0,
  );

  const clearFilters = () => {
    setSeverityFilter("all");
    setAcknowledgedFilter(null);
    setVerdictFilter("all");
    setOffset(0);
  };

  const openRules = () => {
    setRulesOpen(true);
    router.replace("/alerts?tab=rules");
  };

  const onOverrideVerdict = async (
    id: string,
    verdict: "real_incident" | "benign",
  ) => {
    if (!orgId) return;
    try {
      await api.overrideAlertVerdict(orgId, id, verdict);
      toast.success(
        verdict === "real_incident"
          ? "Marked as real incident"
          : "Marked as benign",
      );
      void eventsQuery.refetch();
    } catch (e) {
      toast.error(
        "Override failed",
        e instanceof Error ? e.message : undefined,
      );
    }
  };

  return {
    currentOrg,
    searchParams,
    router,
    tab,
    setTab,
    severityFilter,
    setSeverityFilter,
    verdictFilter,
    setVerdictFilter,
    acknowledgedFilter,
    setAcknowledgedFilter,
    selectedAlerts,
    setSelectedAlerts,
    alertId,
    setUrlState,
    offset,
    setOffset,
    rulesOpen,
    setRulesOpen,
    showSignals,
    channelConfigured,
    limit,
    alertsQuery,
    rulesQuery,
    hasAlertRules,
    rulesReady,
    rulesError,
    loading,
    refreshing,
    total,
    unreadCount,
    alerts,
    triageEvents,
    fetchAlerts,
    ackLoading,
    handleAcknowledge,
    handleBatchAcknowledge,
    toggleSelect,
    severityCounts,
    hasSelection,
    selectedAlert,
    alertIndex,
    clearFilters,
    openRules,
    onOverrideVerdict,
    eventsQuery,
  };
}
