"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { useQueryTab } from "@/hooks/use-query-tab";
import { useToast } from "@/components/ui/toast";
import { api, nlAlertsApi, integrationsApi } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, DetailPanelShell, useResourceUrlState, ResourceOsToolbar, BulkActionBar, VirtualizedList } from "@/components/portal-os";
import { incidentHref, traceHref } from "@/lib/portal-cross-links";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import {
  Bell,
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  Loader2,
  Check,
  ShieldAlert,
  Zap,
  Megaphone,
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCw } from "lucide-react";

const ALERT_TABS = ["feed", "signals"] as const;

const SignalsView = dynamic(() => import("@/app/(portal)/signals/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  ),
});

const BASE_CHANNEL_CONFIGURED: Record<string, boolean> = {
  in_app: true,
  websocket: true,
  webhook: Boolean(process.env.NEXT_PUBLIC_ALERT_WEBHOOK_CONFIGURED),
  email: false,
  slack: false,
  pagerduty: false,
};

interface AlertItem {
  alert_id: string;
  title: string;
  description?: string;
  source?: string;
  message: string;
  severity: string;
  entity_id: string;
  acknowledged: boolean;
  triggered_at?: string;
  created_at: string;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  channels: string[];
  metadata?: Record<string, unknown>;
}

interface __AlertListResponse {
  alerts: AlertItem[];
  total: number;
  unread_count: number;
}

type SeverityFilter = "all" | "critical" | "high" | "warning" | "info" | "debug";
type VerdictFilter = "all" | "real_incident" | "benign" | "duplicate" | "pending";

const VERDICT_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  real_incident: { label: "Real", color: "text-[var(--error)]", bg: "bg-[var(--error)]/10" },
  benign: { label: "Benign", color: "text-[var(--text-muted)]", bg: "bg-[var(--bg-tertiary)]" },
  duplicate: { label: "Duplicate", color: "text-[var(--accent)]", bg: "bg-[var(--accent-faint)]" },
  pending: { label: "Pending", color: "text-[var(--warning)]", bg: "bg-[var(--warning-bg)]" },
};

const SEVERITY_CONFIG: Record<string, { icon: typeof AlertCircle; color: string; bg: string; label: string }> = {
  critical: { icon: ShieldAlert, color: "text-[var(--error)]", bg: "bg-[var(--error)]/10", label: "Critical" },
  high: { icon: AlertTriangle, color: "text-[var(--warning)]", bg: "bg-[var(--warning)]/10", label: "High" },
  warning: { icon: AlertCircle, color: "text-[var(--warning)]", bg: "bg-[var(--warning-bg)]", label: "Warning" },
  info: { icon: Info, color: "text-[var(--accent)]", bg: "bg-[var(--accent-faint)]", label: "Info" },
  debug: { icon: Zap, color: "text-[var(--text-muted)]", bg: "bg-[var(--bg-tertiary)]", label: "Debug" } };

function getSeverityConfig(severity: string) {
  return SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
}

export default function AlertsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentOrg, orgSyncing } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const [tab, setTab] = useQueryTab("tab", ALERT_TABS, "feed");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<boolean | null>(null);
  const [selectedAlerts, setSelectedAlerts] = useState<Set<string>>(new Set());
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const alertId = urlState.alertId;
  const [offset, setOffset] = useState(0);
  // Rules is a feed-panel toggle (?tab=rules), not a hub peer of Feed/Signals.
  // useQueryTab ignores unknown values and falls back to "feed".
  const [rulesOpen, setRulesOpen] = useState(
    searchParams.get("tab") === "rules",
  );
  const showSignals = tab === "signals";
  const [channelConfigured, setChannelConfigured] = useState(BASE_CHANNEL_CONFIGURED);
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
        if (!cancelled) {
          setChannelConfigured(BASE_CHANNEL_CONFIGURED);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const alertsParams: { severity?: string; acknowledged?: boolean; limit: number; offset: number } = {
    limit,
    offset,
    ...(severityFilter !== "all" ? { severity: severityFilter } : {}),
    ...(acknowledgedFilter !== null ? { acknowledged: acknowledgedFilter } : {}),
  };
  const alertsQuery = useOrgQuery(
    queryKeys.alerts.list(orgId, alertsParams),
    orgId,
    () => api.listAlerts(orgId!, alertsParams),
    // P4: ≥30s idle poll; pauses when document hidden (RQ default).
    // Tab-gated: skip while Signals/Rules tabs are active.
    // Skip while Clerk↔Eden org sync is in flight to avoid a false 404.
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
  // Map listAlerts envelope → page AlertItem shape (message ← description).
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
    // P4 consolidate: listAlerts keeps the 30s poll; triage events
    // load once (and on filter/key change) — avoid dual 30s RPS.
    {
      enabled: !orgSyncing && !showSignals && !rulesOpen,
    },
  );
  const triageEvents = eventsQuery.data?.events ?? [];

  const fetchAlerts = () => void alertsQuery.refetch();

  const ackMutation = useOrgMutation(
    (alertId: string) => api.acknowledgeAlert(orgId!, alertId),
    { invalidateKeys: [queryKeys.alerts.list(orgId)] },
  );
  const batchAckMutation = useOrgMutation(
    (ids: string[]) => api.acknowledgeAlertsBatch(orgId!, ids),
    { invalidateKeys: [queryKeys.alerts.list(orgId)] },
  );
  const ackLoading = batchAckMutation.isPending;

  const handleAcknowledge = async (alertId: string) => {
    if (!orgId) return;
    try {
      await ackMutation.mutateAsync(alertId);
      toast.success("Alert acknowledged");
    } catch (e) {
      toast.error("Could not acknowledge alert", e instanceof Error ? e.message : undefined);
    }
  };

  const handleBatchAcknowledge = async () => {
    const ids = Array.from(selectedAlerts);
    if (ids.length === 0 || !orgId) return;
    try {
      await batchAckMutation.mutateAsync(ids);
      setSelectedAlerts(new Set());
      toast.success(`Acknowledged ${ids.length} alert${ids.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error("Batch acknowledge failed", e instanceof Error ? e.message : undefined);
    }
  };

  const toggleSelect = (alertId: string) => {
    setSelectedAlerts((prev) => {
      const next = new Set(prev);
      if (next.has(alertId)) {
        next.delete(alertId);
      } else {
        next.add(alertId);
      }
      return next;
    });
  };

  // Page-window counts only — listAlerts returns one offset/limit slice;
  // chip totals are not org-wide until the API exposes severity aggregates.
  const severityCounts = alerts.reduce((acc, a) => {
    acc[a.severity] = (acc[a.severity] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const hasSelection = selectedAlerts.size > 0;
  const selectedAlert = alertId ? alerts.find((a) => a.alert_id === alertId) ?? null : null;
  const alertIndex = alertId ? alerts.findIndex((a) => a.alert_id === alertId) : -1;

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Bell}
        feature="Alerts"
        description="Alert rules and the live feed are org-scoped. Create or select an organization."
      />
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        const next = v as (typeof ALERT_TABS)[number];
        if (next === "signals") setRulesOpen(false);
        setTab(next);
      }}
    >
    <CoreResourcePage
      header={
        <PageHeader
          title="Alerts"
          subtitle={
            tab === "signals"
              ? "Signals nest here — plain-English metric thresholds that feed notification rules."
              : loading
                ? "..."
                : `${total} alerts · ${unreadCount} unread`
          }
          description="Watch thresholds on traces, costs, and quality. Delivery channels live in Settings; Signals nest as a hub tab."
          actions={
          tab === "feed" ? (
          <div className="flex items-center gap-space-2">
            <Button
              variant="ghost"
              size="default"
              onClick={fetchAlerts}
              disabled={loading || refreshing}
              loading={refreshing}
              aria-label="Refresh alerts"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          {hasSelection && (
            <Button
              size="sm"
              onClick={() => void handleBatchAcknowledge()}
              disabled={ackLoading}
              aria-label={`Acknowledge ${selectedAlerts.size} selected alerts`}
              className="min-h-11"
            >
              {ackLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Acknowledge {selectedAlerts.size}
            </Button>
          )}
          </div>
          ) : null
        }
        />
      }
      toolbar={
        <div
          className="flex flex-col gap-space-3"
          data-testid="alerts-toolbar"
        >
          <div className="flex flex-wrap items-end gap-space-2">
            <TabsList
              variant="underline"
              aria-label="Alerts sections"
              className="h-auto flex-1 justify-start gap-space-1 bg-transparent"
            >
              <TabsTrigger variant="underline" value="feed" title="Feed" className="min-h-11">
                Feed
              </TabsTrigger>
              <TabsTrigger variant="underline" value="signals" title="Signals" className="min-h-11">
                Signals
              </TabsTrigger>
            </TabsList>
            {tab === "feed" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="default"
                    className="min-h-11"
                    aria-label="More links"
                  >
                    More
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  <DropdownMenuLabel>Related</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href="/settings">Settings</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/issues?tab=incidents">Incidents</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/traces">Traces</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          {tab === "feed" ? (
            <ResourceOsToolbar
              resourceKey="alerts"
              sticky
              onCreateAlert={() => {
                setRulesOpen(true);
                router.replace("/alerts?tab=rules");
              }}
              exportRows={alerts.map((a) => ({
                id: a.alert_id,
                title: a.title,
                severity: a.severity,
                acknowledged: a.acknowledged,
                created_at: a.created_at,
              }))}
              exportFilename="alerts.csv"
              selects={[
                {
                  key: "severity",
                  label: "Severity",
                  value: severityFilter === "all" ? "" : severityFilter,
                  options: (["critical", "high", "warning", "info", "debug"] as const).map(
                    (sev) => ({
                      value: sev,
                      label: `${getSeverityConfig(sev).label}${
                        severityCounts[sev] ? ` (${severityCounts[sev]})` : ""
                      }`,
                    }),
                  ),
                },
                {
                  key: "ack",
                  label: "Ack state",
                  value:
                    acknowledgedFilter === null
                      ? ""
                      : acknowledgedFilter
                        ? "acknowledged"
                        : "unread",
                  options: [
                    { value: "unread", label: "Unread" },
                    { value: "acknowledged", label: "Acknowledged" },
                  ],
                },
                {
                  key: "verdict",
                  label: "Verdict",
                  value: verdictFilter === "all" ? "" : verdictFilter,
                  options: (["real_incident", "benign", "duplicate", "pending"] as const).map(
                    (v) => ({
                      value: v,
                      label: VERDICT_CONFIG[v]?.label ?? v,
                    }),
                  ),
                },
              ]}
              onFiltersChange={(next) => {
                const sev = next.severity?.trim();
                setSeverityFilter(
                  sev && sev !== "all" ? (sev as SeverityFilter) : "all",
                );
                const ack = next.ack?.trim();
                setAcknowledgedFilter(
                  ack === "acknowledged" ? true : ack === "unread" ? false : null,
                );
                const verdict = next.verdict?.trim();
                setVerdictFilter(
                  verdict && verdict !== "all" ? (verdict as VerdictFilter) : "all",
                );
                setOffset(0);
              }}
            >
              <Button
                type="button"
                size="sm"
                variant={rulesOpen ? "secondary" : "outline"}
                className="min-h-11"
                onClick={() => {
                  const next = !rulesOpen;
                  setRulesOpen(next);
                  const params = new URLSearchParams(searchParams.toString());
                  if (next) {
                    params.set("tab", "rules");
                  } else {
                    params.delete("tab");
                  }
                  const qs = params.toString();
                  router.replace(qs ? `/alerts?${qs}` : "/alerts");
                }}
              >
                <Megaphone className="w-3.5 h-3.5" />
                Rules
                {rulesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </Button>
            </ResourceOsToolbar>
          ) : null}
        </div>
      }
      kpiStrip={
        tab === "feed" && !loading ? (
          <div
            className="flex flex-wrap items-center gap-space-2"
            data-testid="alerts-severity-strip"
            aria-label="Severity counts"
          >
            {(["critical", "high", "warning", "info"] as const).map((sev) => {
              const cfg = getSeverityConfig(sev);
              const count = severityCounts[sev] ?? 0;
              const active = severityFilter === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => {
                    setSeverityFilter(active ? "all" : sev);
                    setOffset(0);
                  }}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-space-1.5 rounded-md px-space-2.5 text-xs font-medium transition-colors",
                    active
                      ? cn(cfg.bg, cfg.color, "ring-1 ring-current/30")
                      : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  )}
                  aria-pressed={active}
                >
                  <span className={cn("font-semibold tabular-nums", active ? undefined : cfg.color)}>
                    {count}
                  </span>
                  {cfg.label}
                </button>
              );
            })}
          </div>
        ) : undefined
      }
      table={
        <>
      <TabsContent value="signals" className="mt-0">
        <EmbeddedSurface>
          <SignalsView />
        </EmbeddedSurface>
      </TabsContent>
      <TabsContent value="feed" className="mt-0 space-y-space-4">
      <BulkActionBar
        count={selectedAlerts.size}
        onClear={() => setSelectedAlerts(new Set())}
        actions={[
          {
            label: "Acknowledge",
            onClick: () => void handleBatchAcknowledge(),
          },
        ]}
      />

      {rulesOpen && (
        <div className="overflow-hidden">
          <AlertRulesPanel
            orgId={currentOrg?.id}
            prefillFilters={{
              realm: searchParams.get("realm") || "",
              outcome: searchParams.get("outcome") || "",
              agent_id: searchParams.get("agent_id") || "",
            }}
          />
        </div>
      )}

      {/* Triage events (F81) */}
      {triageEvents.length > 0 && (
        <div className="space-y-space-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Triage feed
          </h3>
          {triageEvents.map((ev) => {
            const verdictCfg = VERDICT_CONFIG[ev.triage_verdict || "pending"] || VERDICT_CONFIG.pending;
            return (
              <div
                key={ev.id}
                className="rounded-lg bg-[var(--bg-secondary)] p-space-4"
              >
                <div className="mb-space-1 flex items-center gap-space-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{ev.title}</span>
                  <span className={cn("rounded px-space-2 py-space-1 text-xs font-bold uppercase", verdictCfg.bg, verdictCfg.color)}>
                    {verdictCfg.label}
                  </span>
                </div>
                {ev.triage_reason && (
                  <p className="text-xs text-[var(--text-muted)]">{ev.triage_reason}</p>
                )}
                <div className="mt-space-2 flex items-center gap-space-2">
                  {ev.triage_verdict !== "real_incident" && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="min-h-11 px-0"
                      onClick={async () => {
                        if (!orgId) return;
                        try {
                          await api.overrideAlertVerdict(orgId, ev.id, "real_incident");
                          toast.success("Marked as real incident");
                          void eventsQuery.refetch();
                        } catch (e) {
                          toast.error("Override failed", e instanceof Error ? e.message : undefined);
                        }
                      }}
                    >
                      Override → Real
                    </Button>
                  )}
                  {ev.triage_verdict !== "benign" && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="min-h-11 px-0 text-[var(--text-muted)]"
                      onClick={async () => {
                        if (!orgId) return;
                        try {
                          await api.overrideAlertVerdict(orgId, ev.id, "benign");
                          toast.success("Marked as benign");
                          void eventsQuery.refetch();
                        } catch (e) {
                          toast.error("Override failed", e instanceof Error ? e.message : undefined);
                        }
                      }}
                    >
                      Mark benign
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Alert List */}
      <div className="space-y-space-2">
        <QueryState
          loading={loading && alerts.length === 0}
          error={alertsQuery.error}
          data={alerts}
          onRetry={fetchAlerts}
          errorTitle="Could not load alerts"
          isEmpty={(d) => d.length === 0}
          loadingSlot={<LoadingSkeleton variant="table" lines={5} className="p-0 max-w-none" />}
          emptySlot={
            rulesError &&
            severityFilter === "all" &&
            acknowledgedFilter === null ? (
              <ErrorState
                title="Could not verify alert rules"
                message={rulesError}
                action={
                  <Button
                    onClick={() => void rulesQuery.refetch()}
                    variant="outline"
                    size="sm"
                    loading={rulesQuery.isFetching}
                    data-testid="alerts-rules-retry"
                  >
                    Try again
                  </Button>
                }
              />
            ) : (
              <EmptyState
                variant="plain"
                icon={Bell}
                title={
                  severityFilter !== "all" || acknowledgedFilter !== null
                    ? "No matching alerts"
                    : !rulesReady
                      ? "Checking alert rules…"
                      : hasAlertRules
                        ? "All clear"
                        : "No alert rules yet"
                }
                description={
                  severityFilter !== "all" || acknowledgedFilter !== null
                    ? "No alerts match the current filters. Clear filters to see the full feed."
                    : !rulesReady
                      ? "Confirming whether notification rules exist before treating an empty feed as healthy."
                      : hasAlertRules
                        ? "No active alerts for your rules. New rows appear here when thresholds fire."
                        : "No notification rules configured. Empty does not mean healthy — create a rule to watch cost, quality, or pipeline thresholds."
                }
                size="lg"
                action={
                  severityFilter !== "all" || acknowledgedFilter !== null ? (
                    <Button
                      variant="link"
                      onClick={() => {
                        setSeverityFilter("all");
                        setAcknowledgedFilter(null);
                        setVerdictFilter("all");
                        setOffset(0);
                      }}
                      className="min-h-11 px-0"
                      data-testid="alerts-clear-filters"
                    >
                      Clear filters
                    </Button>
                  ) : !rulesReady ? null : (
                    <Button
                      type="button"
                      onClick={() => {
                        setRulesOpen(true);
                        const params = new URLSearchParams(searchParams.toString());
                        params.set("tab", "rules");
                        router.replace(`/alerts?${params.toString()}`);
                      }}
                      className="min-h-11"
                      data-testid="alerts-create-rule-cta"
                    >
                      Create rule
                    </Button>
                  )
                }
              />
            )
          }
        >
          {() => (
            <>
            <VirtualizedList
              items={alerts}
              rowKey={(alert) => alert.alert_id}
              rowHeight={108}
            >
              {(alert) => {
              const config = getSeverityConfig(alert.severity);
              const Icon = config.icon;
              const isSelected = selectedAlerts.has(alert.alert_id);
              const isActive = alertId === alert.alert_id;

              return (
                <div
                  key={alert.alert_id}
                  className={cn(
                    "rounded-lg transition-all",
                    isSelected || isActive
                      ? "bg-[var(--accent-faint)]/40 ring-1 ring-[var(--accent)]/30"
                      : "hover:bg-[var(--bg-secondary)]",
                  )}
                >
                  <div
                    className="flex cursor-pointer items-start gap-space-3 p-space-4"
                    onClick={() =>
                      setUrlState({ alertId: isActive ? undefined : alert.alert_id })
                    }
                  >
                    {/* Checkbox */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(alert.alert_id);
                      }}
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={isSelected ? `Deselect ${alert.title}` : `Select ${alert.title}`}
                      className={cn(
                        "mt-0.5 w-4 h-4 rounded border flex items-center justify-center transition-colors flex-shrink-0",
                        isSelected
                          ? "bg-[var(--accent)] border-[var(--accent)]"
                          : "border-[var(--border-default)] hover:border-[var(--accent)]"
                      )}
                    >
                      {isSelected && <Check className="w-3 h-3 text-[var(--bg-base)]" />}
                    </button>

                    {/* Severity Icon */}
                    <div className={cn("p-space-2 rounded-lg flex-shrink-0", config.bg)}>
                      <Icon className={cn("w-4 h-4", config.color)} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="mb-space-1 flex items-center gap-space-2">
                        <span className={cn("text-sm font-semibold", alert.acknowledged ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]")}>
                          {alert.title}
                        </span>
                        <span className={cn("rounded px-space-2 py-space-1 text-xs font-bold uppercase", config.bg, config.color)}>
                          {config.label}
                        </span>
                        {!alert.acknowledged && (
                          <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full" />
                        )}
                      </div>
                      <p className="text-xs text-[var(--text-muted)] line-clamp-2">{alert.message}</p>
                      <div className="mt-space-2 flex items-center gap-space-3">
                        <span className="flex items-center gap-space-1 text-xs text-[var(--text-muted)]">
                          <Clock className="w-3 h-3" />
                          {formatRelativeTime(alert.created_at)}
                        </span>
                        {alert.entity_id && (
                          <span className="text-xs text-[var(--text-muted)] font-mono">
                            {alert.entity_id.slice(0, 12)}
                          </span>
                        )}
                        {alert.channels.length > 0 && (
                          <span className="flex flex-wrap gap-space-1 text-xs">
                            {alert.channels.map((ch) => (
                              <span
                                key={ch}
                                className={cn(
                                  "rounded px-space-2 py-space-1",
                                  channelConfigured[ch]
                                    ? "text-[var(--text-muted)]"
                                    : "text-[var(--text-muted)]/50 line-through bg-[var(--bg-muted)]",
                                )}
                                title={
                                  channelConfigured[ch]
                                    ? ch
                                    : `${ch} (not configured)`
                                }
                              >
                                {ch}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-space-1">
                      {!alert.acknowledged && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleAcknowledge(alert.alert_id);
                          }}
                          aria-label={`Acknowledge alert: ${alert.title}`}
                          title="Acknowledge"
                          className="min-h-11 min-w-11"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
              }}
            </VirtualizedList>

            {/* Pagination */}
            {total > limit && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                >
                  Previous
                </Button>
                <span className="text-xs text-[var(--text-muted)]">
                  {offset + 1}–{Math.min(offset + limit, total)} of {total}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total}
                >
                  Next
                </Button>
              </div>
            )}
          </>
          )}
        </QueryState>
      </div>
      </TabsContent>
        </>
      }
      detail={
        tab === "feed" && alertId && selectedAlert ? (
          <DetailPanelShell
            open
            onClose={() => setUrlState({ alertId: undefined })}
            title={selectedAlert.title}
            onPrev={
              alertIndex > 0
                ? () => setUrlState({ alertId: alerts[alertIndex - 1]?.alert_id })
                : undefined
            }
            onNext={
              alertIndex >= 0 && alertIndex < alerts.length - 1
                ? () => setUrlState({ alertId: alerts[alertIndex + 1]?.alert_id })
                : undefined
            }
            headerActions={
              <div className="flex flex-wrap items-center gap-space-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-h-11" aria-label="Related surfaces">
                      Go to
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem]">
                    <DropdownMenuLabel>Go to</DropdownMenuLabel>
                    <DropdownMenuItem asChild>
                      <Link href={incidentHref()}>View incidents</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link
                        href={
                          selectedAlert.entity_id?.startsWith("trace")
                          || (selectedAlert.metadata?.trace_id as string | undefined)
                            ? traceHref(
                                (selectedAlert.metadata?.trace_id as string) ?? selectedAlert.entity_id,
                              )
                            : "/traces"
                        }
                      >
                        {selectedAlert.entity_id?.startsWith("trace")
                        || (selectedAlert.metadata?.trace_id as string | undefined)
                          ? "Example traces"
                          : "Traces hub"}
                      </Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {!selectedAlert.acknowledged ? (
                  <Button
                    size="sm"
                    onClick={() => void handleAcknowledge(selectedAlert.alert_id)}
                  >
                    Acknowledge
                  </Button>
                ) : null}
              </div>
            }
          >
            <div className="flex flex-col gap-space-2 p-space-4">
              <p className="text-sm text-[var(--text-secondary)]">{selectedAlert.message}</p>
              <DetailRow label="Alert ID" value={selectedAlert.alert_id} />
              <DetailRow label="Entity" value={selectedAlert.entity_id || "—"} />
              <DetailRow label="Severity" value={selectedAlert.severity} />
              <DetailRow label="Created" value={new Date(selectedAlert.created_at).toLocaleString()} />
              <DetailRow label="Channels" value={selectedAlert.channels.join(", ") || "—"} />
              <DetailRow label="Status" value={selectedAlert.acknowledged ? "Acknowledged" : "Unread"} />
            </div>
          </DetailPanelShell>
        ) : null
      }
    />
    </Tabs>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-space-4">
      <span className="shrink-0 text-xs uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
      <span className="truncate font-mono text-xs text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

function AlertRulesPanel({
  orgId,
  prefillFilters,
}: {
  orgId?: string;
  prefillFilters?: { realm: string; outcome: string; agent_id: string };
}) {
  const toast = useToast();
  const [nlText, setNlText] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [compiledEql, setCompiledEql] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);

  const rulesQuery = useOrgQuery(
    queryKeys.alerts.nlRules(orgId),
    orgId,
    () => api.listNlAlertRules(orgId!),
  );
  const nlRules = rulesQuery.data?.rules ?? [];
  const loading = rulesQuery.isLoading;
  const rulesError = rulesQuery.error?.message ?? null;

  useEffect(() => {
    if (!prefillFilters) return;
    const parts: string[] = [];
    if (prefillFilters.outcome) parts.push(`outcome is ${prefillFilters.outcome}`);
    if (prefillFilters.realm) parts.push(`realm is ${prefillFilters.realm}`);
    if (prefillFilters.agent_id) parts.push(`agent_id is ${prefillFilters.agent_id}`);
    if (parts.length > 0) {
      setNlText(`Alert me when traces match ${parts.join(" and ")} and error rate exceeds 5%`);
    }
  }, [prefillFilters]);

  const handleCompile = async () => {
    if (!orgId || !nlText.trim()) return;
    setCompiling(true);
    try {
      const ctx: Record<string, unknown> = {};
      if (prefillFilters) {
        const filters: Record<string, string> = {};
        if (prefillFilters.realm) filters.realm = prefillFilters.realm;
        if (prefillFilters.outcome) filters.outcome = prefillFilters.outcome;
        if (prefillFilters.agent_id) filters.agent_id = prefillFilters.agent_id;
        if (Object.keys(filters).length) ctx.filters = filters;
      }
      const result = await api.compileNlAlert(orgId, { nl_text: nlText, context: ctx });
      setCompiledEql(result.eql);
      setWarnings(result.warnings);
      if (!ruleName) setRuleName(result.suggested_name);
      toast.success("Compiled to EQL");
    } catch (e) {
      toast.error("Compile failed", e instanceof Error ? e.message : undefined);
    } finally {
      setCompiling(false);
    }
  };

  const handleSave = async () => {
    if (!orgId || !compiledEql.trim() || !ruleName.trim()) return;
    setSaving(true);
    try {
      await nlAlertsApi.createRule(orgId, {
        name: ruleName,
        nl_text: nlText,
        compiled_eql: compiledEql,
        triage_enabled: true,
      });
      toast.success("Alert rule saved");
      setNlText("");
      setCompiledEql("");
      setRuleName("");
      setWarnings([]);
      void rulesQuery.refetch();
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-space-4 space-y-space-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-space-2">
        <Megaphone className="w-4 h-4 text-[var(--accent)]" />
        NL Alert Rules
      </h3>

      <div className="space-y-space-2">
        <label className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
          English
        </label>
        <textarea
          value={nlText}
          onChange={(e) => setNlText(e.target.value)}
          rows={3}
          placeholder="Wake me if support agent cost per run exceeds $0.30 for 15 minutes"
          className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm text-[var(--text-primary)]"
        />
        <div className="flex gap-space-2">
          <Button size="sm" onClick={() => void handleCompile()} disabled={compiling || !nlText.trim()} loading={compiling}>
            Compile
          </Button>
        </div>
      </div>

      {compiledEql && (
        <div className="space-y-space-2">
          <label className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
            EQL preview (editable)
          </label>
          <input
            value={ruleName}
            onChange={(e) => setRuleName(e.target.value)}
            placeholder="Rule name"
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm"
          />
          <textarea
            value={compiledEql}
            onChange={(e) => setCompiledEql(e.target.value)}
            rows={4}
            className="w-full font-mono text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2"
          />
          {warnings.length > 0 && (
            <ul className="text-xs text-[var(--warning)] list-disc pl-space-4">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <Button size="sm" onClick={() => void handleSave()} disabled={saving} loading={saving}>
            Save rule
          </Button>
        </div>
      )}

      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
      ) : rulesError ? (
        <ErrorState
          size="sm"
          title="Could not load rules"
          message={rulesError}
          action={
            <Button size="sm" variant="outline" onClick={() => void rulesQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : nlRules.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No NL rules yet. Compile and save above.</p>
      ) : (
        <div className="space-y-space-2 border-t border-[var(--border-default)] pt-space-3">
          <p className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Saved rules</p>
          {nlRules.map((rule) => (
            <div key={rule.id} className="p-space-3 rounded-lg bg-[var(--bg-tertiary)]/50">
              <div className="flex items-center gap-space-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">{rule.name}</span>
                {!rule.enabled && (
                  <span className="px-space-2 py-space-1 text-xs bg-[var(--bg-muted)] text-[var(--text-muted)] rounded">
                    Disabled
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-space-1">{rule.nl_text}</p>
              <pre className="mt-space-1 text-xs font-mono text-[var(--text-secondary)] line-clamp-2">
                {rule.compiled_eql}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
