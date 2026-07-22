"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { useObserveUrlState } from "@/app/(portal)/_hooks/use-observe-url-state";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { api, nlAlertsApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  normalizeObserveSearchParams,
  observeQueryString,
} from "@/lib/observe-url";
import { PageHeader } from "@/components/ui/page-header";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { AlertsToolbar } from "./_components/alerts-toolbar";
import { InboxTable } from "./_components/inbox-table";
import { AlertDetailPanel } from "./_components/alert-detail-panel";
import { AlertDetailSheet } from "./_components/alert-detail-sheet";
import { RulesTable } from "./_components/rules-table";
import { RuleForm, type RuleFormValues } from "./_components/rule-form";
import { SignalsPanel } from "./_components/signals-panel";
import {
  buildAlertIssueHref,
  buildAlertTraceHref,
} from "./_components/alert-links";
import {
  mapApiAlert,
  mapApiEvent,
  mapApiRule,
  parseAlertsTab,
  type AlertRow,
  type AlertsTab,
  type RuleRow,
  type SignalRow,
} from "./_components/alert-types";

const LIVE_POLL_MS = 10_000;
const SOFT_POLL_MS = 45_000;

function AlertsPageInner() {
  const t = useTranslations("alerts");
  const router = useRouter();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { hasPermission, role } = usePermissions();
  const canWrite =
    hasPermission("jobs:write") || (role != null && role !== "viewer");

  const { state, setState, searchParams } = useObserveUrlState();
  const tab = parseAlertsTab(state.tab);
  const q = state.q ?? "";
  const statusFilter = state.filter ?? "";
  const severityFilter = searchParams.get("severity") ?? "";
  const pastHours = state.pastHours ?? "24";
  const live = state.live === "1";
  const alertId = state.alertId;
  const ruleId = searchParams.get("ruleId") ?? undefined;
  const signalId = searchParams.get("signalId") ?? undefined;

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [ackError, setAckError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof RuleFormValues, string>>
  >({});

  const replaceAlertsUrl = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = normalizeObserveSearchParams(
        new URLSearchParams(searchParams.toString()),
      );
      mutate(params);
      router.replace(`/alerts${observeQueryString(params)}`, { scroll: false });
    },
    [router, searchParams],
  );

  const acknowledgedParam =
    statusFilter === "open"
      ? false
      : statusFilter === "acked"
        ? true
        : undefined;

  const alertsQuery = useOrgQuery(
    queryKeys.alerts.list(orgId, {
      severity: severityFilter || undefined,
      acknowledged: acknowledgedParam,
      pastHours,
    }),
    orgId,
    () =>
      api.listAlerts(orgId!, {
        severity: severityFilter || undefined,
        acknowledged: acknowledgedParam,
        limit: 100,
      }),
    {
      enabled: tab === "inbox",
      refetchInterval: live ? LIVE_POLL_MS : SOFT_POLL_MS,
    },
  );

  const rulesQuery = useOrgQuery(
    queryKeys.alerts.rules(orgId),
    orgId,
    () => api.getAlertRules(orgId!),
    { enabled: tab === "rules" },
  );

  const eventsQuery = useOrgQuery(
    queryKeys.alerts.events(orgId, {}),
    orgId,
    () => api.listAlertEvents(orgId!, { limit: 100 }),
    { enabled: tab === "signals" },
  );

  const ackMutation = useOrgMutation(
    (id: string) => api.acknowledgeAlert(orgId!, id),
    { invalidateKeys: [queryKeys.alerts.all] },
  );

  const batchAckMutation = useOrgMutation(
    (ids: string[]) => api.acknowledgeAlertsBatch(orgId!, ids),
    { invalidateKeys: [queryKeys.alerts.all] },
  );

  const alerts: AlertRow[] = useMemo(() => {
    const rows = (alertsQuery.data?.alerts ?? []).map(mapApiAlert);
    let filtered = rows;
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          r.message.toLowerCase().includes(needle) ||
          (r.agentId?.toLowerCase().includes(needle) ?? false),
      );
    }
    if (severityFilter) {
      filtered = filtered.filter((r) => r.severity === severityFilter);
    }
    if (statusFilter === "open" || statusFilter === "acked") {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }
    return filtered;
  }, [alertsQuery.data, q, severityFilter, statusFilter]);

  const rules: RuleRow[] = useMemo(() => {
    const rows = (rulesQuery.data?.rules ?? []).map(mapApiRule);
    if (!q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.condition.toLowerCase().includes(needle),
    );
  }, [rulesQuery.data, q]);

  const signals: SignalRow[] = useMemo(() => {
    const rows = (eventsQuery.data?.events ?? []).map(mapApiEvent);
    if (!q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.kind.toLowerCase().includes(needle) ||
        r.message.toLowerCase().includes(needle),
    );
  }, [eventsQuery.data, q]);

  const selectedAlert =
    alerts.find((a) => a.alertId === alertId) ?? undefined;
  const selectedRule = rules.find((r) => r.ruleId === ruleId) ?? null;

  const inboxFiltersActive = Boolean(
    q.trim() || statusFilter || severityFilter,
  );
  const rulesFiltersActive = Boolean(q.trim());

  const setTabClean = useCallback(
    (next: AlertsTab) => {
      replaceAlertsUrl((params) => {
        if (next === "inbox") params.delete("tab");
        else params.set("tab", next);
        params.delete("alertId");
        params.delete("ruleId");
        params.delete("signalId");
      });
    },
    [replaceAlertsUrl],
  );

  const selectAlert = useCallback(
    (id: string) => {
      setState({ alertId: id });
    },
    [setState],
  );

  const clearAlert = useCallback(() => {
    setState({ alertId: undefined });
  }, [setState]);

  const selectRule = useCallback(
    (id: string) => {
      replaceAlertsUrl((params) => {
        params.set("tab", "rules");
        params.set("ruleId", id);
        params.delete("alertId");
        params.delete("signalId");
      });
    },
    [replaceAlertsUrl],
  );

  const selectSignal = useCallback(
    (id: string) => {
      replaceAlertsUrl((params) => {
        params.set("tab", "signals");
        params.set("signalId", id);
        params.delete("alertId");
        params.delete("ruleId");
      });
    },
    [replaceAlertsUrl],
  );

  useListKeyboardNav(
    tab === "inbox" ? alerts.length : tab === "rules" ? rules.length : 0,
    focusedIndex,
    (idx) => {
      setFocusedIndex(idx);
      if (tab === "inbox") {
        const row = alerts[idx];
        if (row) selectAlert(row.alertId);
      } else if (tab === "rules") {
        const row = rules[idx];
        if (row) selectRule(row.ruleId);
      }
    },
    (tab === "inbox" || tab === "rules") &&
      (tab === "inbox" ? alerts.length : rules.length) > 0,
  );

  useEffect(() => {
    if (tab !== "inbox" || !alertId) return;
    const idx = alerts.findIndex((a) => a.alertId === alertId);
    if (idx >= 0) setFocusedIndex(idx);
  }, [alertId, alerts, tab]);

  const handleAcknowledge = useCallback(
    async (id: string) => {
      setAckError(null);
      try {
        await ackMutation.mutateAsync(id);
      } catch (err) {
        setAckError(
          err instanceof Error ? err.message : t("detail.ackError"),
        );
      }
    },
    [ackMutation, t],
  );

  const handleCreateRule = useCallback(
    async (values: RuleFormValues) => {
      if (!orgId) return;
      setCreateError(null);
      setFieldErrors({});
      if (!values.name.trim()) {
        setFieldErrors({ name: t("rules.errors.nameRequired") });
        throw new Error("validation");
      }
      if (!values.nlText.trim()) {
        setFieldErrors({ nlText: t("rules.errors.conditionRequired") });
        throw new Error("validation");
      }
      setCreating(true);
      try {
        let eql = values.compiledEql.trim();
        if (!eql) {
          const compiled = await api.compileNlAlert(orgId, {
            nl_text: values.nlText.trim(),
          });
          eql = compiled.eql;
        }
        await nlAlertsApi.createRule(orgId, {
          name: values.name.trim(),
          nl_text: values.nlText.trim(),
          compiled_eql: eql,
        });
        await rulesQuery.refetch();
      } catch (err) {
        if (err instanceof Error && err.message === "validation") throw err;
        setCreateError(
          err instanceof Error ? err.message : t("rules.errors.saveFailed"),
        );
        throw err;
      } finally {
        setCreating(false);
      }
    },
    [orgId, rulesQuery, t],
  );

  useKeyboardShortcuts({
    Escape: () => {
      if (tab === "inbox" && alertId) clearAlert();
      else if (tab === "rules" && ruleId) {
        replaceAlertsUrl((p) => p.delete("ruleId"));
      } else if (tab === "signals" && signalId) {
        replaceAlertsUrl((p) => p.delete("signalId"));
      }
    },
    a: () => {
      if (tab === "inbox" && selectedAlert?.status === "open") {
        void handleAcknowledge(selectedAlert.alertId);
      }
    },
    t: () => {
      if (tab !== "inbox" || !selectedAlert) return;
      const href = buildAlertTraceHref(selectedAlert, searchParams);
      if (href) window.location.assign(href);
    },
    i: () => {
      if (tab !== "inbox" || !selectedAlert) return;
      const href = buildAlertIssueHref(selectedAlert, searchParams);
      if (href) window.location.assign(href);
    },
    "1": () => setTabClean("inbox"),
    "2": () => setTabClean("rules"),
    "3": () => setTabClean("signals"),
  });

  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1279px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const showLiveToggle = tab === "inbox";
  const detailOpen = tab === "inbox" && Boolean(alertId && selectedAlert);
  const desktopDetailOpen = detailOpen && !isNarrow;
  const sheetDetailOpen = detailOpen && isNarrow;

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="alerts-page">
      <ResourcePageShell
        header={
          <PageHeader
            title={t("title")}
            subtitle={t("subtitle")}
            actions={
              tab === "inbox" &&
              alerts.some((a) => a.status === "open") &&
              canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="min-h-11"
                  disabled={batchAckMutation.isPending}
                  onClick={() => {
                    const ids = alerts
                      .filter((a) => a.status === "open")
                      .map((a) => a.alertId);
                    if (ids.length) void batchAckMutation.mutateAsync(ids);
                  }}
                  data-testid="alerts-ack-batch"
                >
                  {t("ackBatch")}
                </Button>
              ) : undefined
            }
          />
        }
        toolbar={
          <AlertsToolbar
            tab={tab}
            onTabChange={setTabClean}
            q={q}
            onSearch={(value) => setState({ q: value || undefined })}
            statusFilter={statusFilter}
            onStatusFilter={(value) =>
              setState({ filter: value || undefined })
            }
            severityFilter={severityFilter}
            onSeverityFilter={(value) => {
              replaceAlertsUrl((params) => {
                if (value) params.set("severity", value);
                else params.delete("severity");
              });
            }}
            pastHours={pastHours}
            onPastHours={(value) =>
              setState({ pastHours: value === "24" ? undefined : value })
            }
            live={live}
            onLiveChange={(next) =>
              setState({ live: next ? "1" : undefined })
            }
            showLiveToggle={showLiveToggle}
          />
        }
        table={
          <>
            {tab === "inbox" ? (
              <QueryState
                loading={alertsQuery.isLoading}
                error={alertsQuery.error}
                data={alerts}
                onRetry={() => void alertsQuery.refetch()}
                isEmpty={(rows) => rows.length === 0}
                filtersActive={inboxFiltersActive}
                emptyKind={inboxFiltersActive ? "filter-empty" : "zero-data"}
                loadingSlot={
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                }
                emptySlot={
                  <EmptyState
                    icon={Bell}
                    variant="panel"
                    title={t("inbox.empty.title")}
                    description={t("inbox.empty.body")}
                    action={
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="min-h-11"
                          onClick={() => setTabClean("rules")}
                        >
                          {t("inbox.empty.configureRules")}
                        </Button>
                        <Button
                          asChild
                          size="sm"
                          variant="secondary"
                          className="min-h-11"
                        >
                          <Link href="/traces">{t("inbox.empty.openTraces")}</Link>
                        </Button>
                      </div>
                    }
                  />
                }
                filterEmptySlot={
                  <EmptyState
                    variant="panel"
                    title={t("inbox.filterEmpty.title")}
                    description={t("inbox.filterEmpty.body")}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="min-h-11"
                        onClick={() => {
                          setState({ q: undefined, filter: undefined });
                          replaceAlertsUrl((p) => p.delete("severity"));
                        }}
                      >
                        {t("inbox.filterEmpty.clear")}
                      </Button>
                    }
                  />
                }
              >
                {(rows) => (
                  <InboxTable
                    rows={rows}
                    selectedId={alertId}
                    focusedIndex={focusedIndex}
                    onSelect={selectAlert}
                    onFocusIndex={setFocusedIndex}
                  />
                )}
              </QueryState>
            ) : null}

            {tab === "rules" ? (
              <div className="space-y-4">
                <QueryState
                  loading={rulesQuery.isLoading}
                  error={rulesQuery.error}
                  data={rules}
                  onRetry={() => void rulesQuery.refetch()}
                  isEmpty={(rows) => rows.length === 0}
                  filtersActive={rulesFiltersActive}
                  emptyKind={rulesFiltersActive ? "filter-empty" : "zero-data"}
                  loadingSlot={
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  }
                  emptySlot={
                    <EmptyState
                      icon={Bell}
                      variant="panel"
                      title={t("rules.empty.title")}
                      description={t("rules.empty.body")}
                    />
                  }
                  filterEmptySlot={
                    <EmptyState
                      variant="panel"
                      title={t("rules.filterEmpty.title")}
                      description={t("rules.filterEmpty.body")}
                      action={
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="min-h-11"
                          onClick={() => setState({ q: undefined })}
                        >
                          {t("rules.filterEmpty.clear")}
                        </Button>
                      }
                    />
                  }
                >
                  {(rows) => (
                    <RulesTable
                      rows={rows}
                      selectedId={ruleId}
                      focusedIndex={focusedIndex}
                      onSelect={selectRule}
                      onFocusIndex={setFocusedIndex}
                    />
                  )}
                </QueryState>
                <RuleForm
                  selected={selectedRule}
                  canWrite={canWrite}
                  onCreate={handleCreateRule}
                  creating={creating}
                  createError={createError}
                  fieldErrors={fieldErrors}
                />
              </div>
            ) : null}

            {tab === "signals" ? (
              <SignalsPanel
                signals={signals}
                loading={eventsQuery.isLoading}
                error={eventsQuery.error}
                onRetry={() => void eventsQuery.refetch()}
                selectedId={signalId}
                onSelect={selectSignal}
                searchParams={searchParams}
                onGoRules={() => setTabClean("rules")}
              />
            ) : null}
          </>
        }
        detail={
          desktopDetailOpen && selectedAlert ? (
            <div data-testid="alert-detail-desktop">
              <DetailPanelShell
                open
                onClose={clearAlert}
                title={selectedAlert.title}
                mobileDrawer={false}
              >
                <AlertDetailPanel
                  alert={selectedAlert}
                  searchParams={searchParams}
                  onAcknowledge={(id) => void handleAcknowledge(id)}
                  acknowledging={ackMutation.isPending}
                  ackError={ackError}
                />
              </DetailPanelShell>
            </div>
          ) : undefined
        }
      />

      <AlertDetailSheet
        open={sheetDetailOpen}
        alert={selectedAlert ?? null}
        searchParams={searchParams}
        onClose={clearAlert}
        onAcknowledge={(id) => void handleAcknowledge(id)}
        acknowledging={ackMutation.isPending}
        ackError={ackError}
      />

      {live && tab === "inbox" ? (
        <div
          className="sr-only"
          aria-live="polite"
          data-testid="alerts-live-region"
        >
          {t("live.region", { count: alerts.length })}
        </div>
      ) : null}
    </div>
  );
}

export default function AlertsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-6xl space-y-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <AlertsPageInner />
    </Suspense>
  );
}
