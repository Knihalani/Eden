"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { api, nlAlertsApi, integrationsApi } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, DetailPanelShell, useResourceUrlState, ResourceOsToolbar, BulkActionBar } from "@/components/portal-os";
import { CrossLinkBar } from "@/components/portal-os/CrossLinkBar";
import { incidentHref, traceHref } from "@/lib/portal-cross-links";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { motion, AnimatePresence } from "framer-motion";
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
    <Suspense fallback={null}>
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const searchParams = useSearchParams();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<boolean | null>(null);
  const [selectedAlerts, setSelectedAlerts] = useState<Set<string>>(new Set());
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const alertId = urlState.alertId;
  const [offset, setOffset] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(
    searchParams.get("tab") === "rules",
  );
  const showSignals = searchParams.get("tab") === "signals";
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
    // 15s polling — refetchIntervalInBackground defaults to false,
    // so this pauses on tab-hidden the same way the old usePolling
    // hook did; the 401/403 permanent-bail semantics come from the
    // global QueryClient retry policy (see query-provider.tsx).
    { refetchInterval: 15_000 },
  );
  const rulesQuery = useOrgQuery(
    queryKeys.alerts.nlRules(orgId),
    orgId,
    () => api.listNlAlertRules(orgId!),
  );
  const hasAlertRules = (rulesQuery.data?.rules?.length ?? 0) > 0;
  const rulesReady = !rulesQuery.isLoading && !rulesQuery.isPending;
  const loading = alertsQuery.isLoading;
  const refreshing = alertsQuery.isFetching && !loading;
  const error = alertsQuery.error?.message ?? null;
  const total = alertsQuery.data?.total ?? 0;
  const unreadCount = alertsQuery.data?.unread_count ?? 0;
  // The API returns rows without the legacy ``message``,
  // ``entity_id``, ``channels`` fields. Map at the boundary so the
  // rest of the page can keep the existing local shape.
  const alerts: AlertItem[] = (alertsQuery.data?.alerts ?? []).map((a) => ({
    alert_id: a.alert_id,
    title: a.title,
    description: a.description,
    source: a.source,
    message: a.description,
    severity: a.severity,
    entity_id: "",
    acknowledged: a.acknowledged,
    triggered_at: a.triggered_at,
    created_at: a.triggered_at,
    acknowledged_at: a.acknowledged_at,
    acknowledged_by: a.acknowledged_by,
    channels: [],
    metadata: a.metadata,
  }));

  const eventsParams = useMemo(
    () => ({
      ...(verdictFilter !== "all" ? { verdict: verdictFilter } : {}),
      limit,
      offset,
    }),
    [verdictFilter, limit, offset],
  );
  const eventsQuery = useOrgQuery(
    queryKeys.alerts.events(orgId, eventsParams),
    orgId,
    () => api.listAlertEvents(orgId!, eventsParams),
    { refetchInterval: 15_000 },
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
        description="Alert rules and the live feed belong to an organization, so create one to start getting notified."
      />
    );
  }

  if (showSignals) {
    return (
      <CoreResourcePage
        header={
          <PageHeader
            title="Alerts"
            subtitle="Threshold notifications and custom signal rules."
            icon={Bell}
          />
        }
        toolbar={
          <div className="mb-4 flex gap-2 text-sm">
            <Link href="/alerts" className="text-[var(--accent)] hover:underline">Feed</Link>
            <span className="text-[var(--text-muted)]">·</span>
            <span className="font-medium text-[var(--text-primary)]">Signals</span>
          </div>
        }
        table={
          <EmbeddedSurface>
            <SignalsView />
          </EmbeddedSurface>
        }
      />
    );
  }

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Alerts"
          subtitle={loading ? "..." : `${total} alerts · ${unreadCount} unread`}
          icon={Bell}
          description="Configure notifications when traces, costs, or quality cross a threshold."
          actions={
          <div className="flex items-center gap-2">
            <Link
              href="/alerts?tab=signals"
              className="text-xs text-[var(--accent)] hover:underline px-2"
            >
              Signals
            </Link>
            <button
              onClick={fetchAlerts}
              disabled={loading || refreshing}
              aria-label="Refresh alerts"
              className="inline-flex min-h-11 min-w-11 items-center justify-center p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh"
            >
              <RefreshCw className={cn("w-4 h-4", (loading || refreshing) && "animate-spin")} />
            </button>
          {hasSelection && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={handleBatchAcknowledge}
              disabled={ackLoading}
              aria-label={`Acknowledge ${selectedAlerts.size} selected alerts`}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ackLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Acknowledge {selectedAlerts.size}
            </motion.button>
          )}
          </div>
        }
        />
      }
      table={
        <>
      <ResourceOsToolbar
        resourceKey="alerts"
        onCreateAlert={() => {
          window.location.href = "/alerts?tab=rules";
        }}
        exportRows={alerts.map((a) => ({
          id: a.alert_id,
          title: a.title,
          severity: a.severity,
          acknowledged: a.acknowledged,
          created_at: a.created_at,
        }))}
        exportFilename="alerts.csv"
        className="mb-4"
      />
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
      {/* Stats — only when there is feed data or an active severity filter */}
      {(alerts.length > 0 || severityFilter !== "all") && (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {(["critical", "high", "warning", "info", "debug"] as const).map((sev) => {
          const config = getSeverityConfig(sev);
          const count = severityCounts[sev] || 0;
          const Icon = config.icon;
          return (
            <button
              key={sev}
              onClick={() => setSeverityFilter(severityFilter === sev ? "all" : sev)}
              className={cn(
                "flex items-center gap-3 p-3 min-h-11 rounded-lg border transition-all text-left",
                severityFilter === sev
                  ? cn(config.bg, "border-[var(--border-strong)]")
                  : "bg-[var(--bg-primary)] border-[var(--border-default)] hover:border-[var(--border-strong)]"
              )}
            >
              <div className={cn("p-1.5 rounded-md", config.bg)}>
                <Icon className={cn("w-4 h-4", config.color)} />
              </div>
              <div>
                <p className={cn("text-lg font-bold", severityFilter === sev ? config.color : "text-[var(--text-primary)]")}>
                  {count}
                </p>
                <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{config.label}</p>
              </div>
            </button>
          );
        })}
      </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center gap-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg p-1">
          {(["all", "unread", "acknowledged"] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => {
                setAcknowledgedFilter(
                  filter === "all" ? null : filter === "acknowledged" ? true : false
                );
                setOffset(0);
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                (filter === "all" && acknowledgedFilter === null) ||
                (filter === "unread" && acknowledgedFilter === false) ||
                (filter === "acknowledged" && acknowledgedFilter === true)
                  ? "bg-[var(--accent)] text-[var(--bg-base)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
            >
              {filter.charAt(0).toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-[var(--border-default)]" />

        <button
          onClick={() => setRulesOpen(!rulesOpen)}
          className={cn(
            "flex items-center gap-1.5 min-h-11 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
            rulesOpen
              ? "bg-[var(--accent-faint)] text-[var(--accent)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          )}
        >
          <Megaphone className="w-3.5 h-3.5" />
          Rules
          {rulesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        <div className="h-4 w-px bg-[var(--border-default)]" />

        <div className="flex items-center gap-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg p-1">
          {(["all", "real_incident", "benign", "duplicate", "pending"] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setVerdictFilter(v);
                setOffset(0);
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                verdictFilter === v
                  ? "bg-[var(--accent)] text-[var(--bg-base)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
            >
              {v === "all" ? "All verdicts" : VERDICT_CONFIG[v]?.label ?? v}
            </button>
          ))}
        </div>
      </div>

      {/* Alert Rules Panel */}
      <AnimatePresence>
        {rulesOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden mb-4"
          >
            <AlertRulesPanel
              orgId={currentOrg?.id}
              prefillFilters={{
                realm: searchParams.get("realm") || "",
                outcome: searchParams.get("outcome") || "",
                agent_id: searchParams.get("agent_id") || "",
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-[var(--error)]/20 bg-[var(--error)]/10 text-sm text-[var(--error)] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <Button
              variant="link"
              size="sm"
              onClick={fetchAlerts}
              className="ml-auto"
            >
              Retry
            </Button>
        </div>
      )}

      {/* Triage events (F81) */}
      {triageEvents.length > 0 && (
        <div className="mb-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Triage feed
          </h3>
          {triageEvents.map((ev) => {
            const verdictCfg = VERDICT_CONFIG[ev.triage_verdict || "pending"] || VERDICT_CONFIG.pending;
            return (
              <div
                key={ev.id}
                className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{ev.title}</span>
                  <span className={cn("px-1.5 py-0.5 text-[10px] font-bold uppercase rounded", verdictCfg.bg, verdictCfg.color)}>
                    {verdictCfg.label}
                  </span>
                </div>
                {ev.triage_reason && (
                  <p className="text-xs text-[var(--text-muted)]">{ev.triage_reason}</p>
                )}
                <div className="flex items-center gap-2 mt-2">
                  {ev.triage_verdict !== "real_incident" && (
                    <button
                      type="button"
                      className="text-[10px] text-[var(--accent)] hover:underline"
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
                    </button>
                  )}
                  {ev.triage_verdict !== "benign" && (
                    <button
                      type="button"
                      className="text-[10px] text-[var(--text-muted)] hover:underline"
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
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Alert List */}
      <div className="space-y-2">
        {loading && alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
            <p className="text-sm text-[var(--text-muted)]">Loading alerts...</p>
          </div>
        ) : alerts.length === 0 ? (
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
                ? "No alerts match your current filters. Try clearing the filters to see all alerts."
                : !rulesReady
                  ? "Confirming whether notification rules are configured before calling the feed healthy."
                  : hasAlertRules
                    ? "No active alerts for your rules. New notifications appear here when thresholds fire."
                    : "Alerts fire from rules you define. Create a rule to catch cost spikes, quality drops, and pipeline failures — empty does not mean healthy until rules exist."
            }
            size="lg"
            action={
              severityFilter !== "all" || acknowledgedFilter !== null ? (
                <button
                  onClick={() => {
                    setSeverityFilter("all");
                    setAcknowledgedFilter(null);
                  }}
                  className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] hover:underline"
                >
                  Clear filters
                </button>
              ) : !rulesReady ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setRulesOpen(true);
                    const params = new URLSearchParams(searchParams.toString());
                    params.set("tab", "rules");
                    window.history.replaceState(
                      null,
                      "",
                      `${window.location.pathname}?${params.toString()}`,
                    );
                  }}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--bg-base)] hover:bg-[var(--accent-hover)]"
                  data-testid="alerts-create-rule-cta"
                >
                  Create rule
                </button>
              )
            }
          />
        ) : (
          <>
            {alerts.map((alert) => {
              const config = getSeverityConfig(alert.severity);
              const Icon = config.icon;
              const isSelected = selectedAlerts.has(alert.alert_id);
              const isActive = alertId === alert.alert_id;

              return (
                <motion.div
                  key={alert.alert_id}
                  layout
                  initial={false}
                  animate={{ opacity: alert.acknowledged ? 0.6 : 1 }}
                  className={cn(
                    "rounded-lg border transition-all",
                    isSelected || isActive
                      ? "border-[var(--accent)]/30 bg-[var(--accent-faint)]/20"
                      : "border-[var(--border-default)] bg-[var(--bg-primary)]",
                    !alert.acknowledged && !isSelected && !isActive && "hover:border-[var(--border-strong)]"
                  )}
                >
                  <div
                    className="flex items-start gap-3 p-4 cursor-pointer"
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
                    <div className={cn("p-2 rounded-lg flex-shrink-0", config.bg)}>
                      <Icon className={cn("w-4 h-4", config.color)} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn("text-sm font-semibold", alert.acknowledged ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]")}>
                          {alert.title}
                        </span>
                        <span className={cn("px-1.5 py-0.5 text-[10px] font-bold uppercase rounded", config.bg, config.color)}>
                          {config.label}
                        </span>
                        {!alert.acknowledged && (
                          <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full" />
                        )}
                      </div>
                      <p className="text-xs text-[var(--text-muted)] line-clamp-2">{alert.message}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatRelativeTime(alert.created_at)}
                        </span>
                        {alert.entity_id && (
                          <span className="text-[10px] text-[var(--text-muted)] font-mono">
                            {alert.entity_id.slice(0, 12)}
                          </span>
                        )}
                        {alert.channels.length > 0 && (
                          <span className="text-[10px] flex flex-wrap gap-1">
                            {alert.channels.map((ch) => (
                              <span
                                key={ch}
                                className={cn(
                                  "px-1.5 py-0.5 rounded",
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
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {!alert.acknowledged && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAcknowledge(alert.alert_id);
                          }}
                          aria-label={`Acknowledge alert: ${alert.title}`}
                          className="inline-flex min-h-11 min-w-11 items-center justify-center p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                          title="Acknowledge"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}

            {/* Pagination */}
            {total > limit && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <button
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  Previous
                </button>
                <span className="text-xs text-[var(--text-muted)]">
                  {offset + 1}–{Math.min(offset + limit, total)} of {total}
                </span>
                <button
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
        </>
      }
      detail={
        alertId && selectedAlert ? (
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
              !selectedAlert.acknowledged ? (
                <button
                  type="button"
                  onClick={() => void handleAcknowledge(selectedAlert.alert_id)}
                  className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-[var(--bg-base)]"
                >
                  Acknowledge
                </button>
              ) : null
            }
          >
            <CrossLinkBar
              links={[
                { label: "View incidents", href: incidentHref() },
                ...(selectedAlert.entity_id?.startsWith("trace")
                  || (selectedAlert.metadata?.trace_id as string | undefined)
                  ? [{
                      label: "Example traces",
                      href: traceHref(
                        (selectedAlert.metadata?.trace_id as string) ?? selectedAlert.entity_id,
                      ),
                    }]
                  : [{ label: "Traces hub", href: "/traces" }]),
              ]}
            />
            <div className="p-4 space-y-2">
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
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex-shrink-0">{label}</span>
      <span className="text-xs text-[var(--text-secondary)] font-mono truncate">{value}</span>
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
    <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4 space-y-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
        <Megaphone className="w-4 h-4 text-[var(--accent)]" />
        NL Alert Rules
      </h3>

      <div className="space-y-2">
        <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          English
        </label>
        <textarea
          value={nlText}
          onChange={(e) => setNlText(e.target.value)}
          rows={3}
          placeholder="Wake me if support agent cost per run exceeds $0.30 for 15 minutes"
          className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]"
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void handleCompile()} disabled={compiling || !nlText.trim()}>
            {compiling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Compile"}
          </Button>
        </div>
      </div>

      {compiledEql && (
        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            EQL preview (editable)
          </label>
          <input
            value={ruleName}
            onChange={(e) => setRuleName(e.target.value)}
            placeholder="Rule name"
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm"
          />
          <textarea
            value={compiledEql}
            onChange={(e) => setCompiledEql(e.target.value)}
            rows={4}
            className="w-full font-mono text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2"
          />
          {warnings.length > 0 && (
            <ul className="text-[10px] text-[var(--warning)] list-disc pl-4">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save rule"}
          </Button>
        </div>
      )}

      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
      ) : nlRules.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No NL rules yet. Compile and save above.</p>
      ) : (
        <div className="space-y-2 border-t border-[var(--border-default)] pt-3">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Saved rules</p>
          {nlRules.map((rule) => (
            <div key={rule.id} className="p-3 rounded-lg bg-[var(--bg-tertiary)]/50">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">{rule.name}</span>
                {!rule.enabled && (
                  <span className="px-1.5 py-0.5 text-[10px] bg-[var(--bg-muted)] text-[var(--text-muted)] rounded">
                    Disabled
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{rule.nl_text}</p>
              <pre className="mt-1 text-[10px] font-mono text-[var(--text-secondary)] line-clamp-2">
                {rule.compiled_eql}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
