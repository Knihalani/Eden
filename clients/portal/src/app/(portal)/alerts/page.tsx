"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell,
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  XCircle,
  Filter,
  Loader2,
  Check,
  Trash2,
  ShieldAlert,
  Zap,
  Megaphone,
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCw,
  Layers,
} from "lucide-react";

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

interface AlertListResponse {
  alerts: AlertItem[];
  total: number;
  unread_count: number;
}

type SeverityFilter = "all" | "critical" | "high" | "warning" | "info" | "debug";

const SEVERITY_CONFIG: Record<string, { icon: typeof AlertCircle; color: string; bg: string; label: string }> = {
  critical: { icon: ShieldAlert, color: "text-[var(--error)]", bg: "bg-[var(--error)]/10", label: "Critical" },
  high: { icon: AlertTriangle, color: "text-[var(--warning)]", bg: "bg-[var(--warning)]/10", label: "High" },
  warning: { icon: AlertCircle, color: "text-[var(--warning)]", bg: "bg-[var(--warning-bg)]", label: "Warning" },
  info: { icon: Info, color: "text-[var(--accent)]", bg: "bg-[var(--accent-faint)]", label: "Info" },
  debug: { icon: Zap, color: "text-[var(--text-muted)]", bg: "bg-[var(--bg-tertiary)]", label: "Debug" },
};

function getSeverityConfig(severity: string) {
  return SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
}

export default function AlertsPage() {
  const { currentOrg } = useOrg();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<boolean | null>(null);
  const [selectedAlerts, setSelectedAlerts] = useState<Set<string>>(new Set());
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const limit = 50;

  const fetchAlerts = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const params: { severity?: string; acknowledged?: boolean; limit: number; offset: number } = {
        limit,
        offset,
      };
      if (severityFilter !== "all") params.severity = severityFilter;
      if (acknowledgedFilter !== null) params.acknowledged = acknowledgedFilter;

      const data = await api.listAlerts(currentOrg.id, params);
      // The API returns rows without the legacy ``message``,
      // ``entity_id``, ``channels`` fields. Map at the boundary
      // so the rest of the page can keep the existing local shape.
      setAlerts(
        data.alerts.map((a) => ({
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
        })),
      );
      setTotal(data.total);
      setUnreadCount(data.unread_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, severityFilter, acknowledgedFilter, offset, limit]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 15000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const handleAcknowledge = async (alertId: string) => {
    try {
      await api.acknowledgeAlert(alertId);
      setAlerts((prev) =>
        prev.map((a) => (a.alert_id === alertId ? { ...a, acknowledged: true } : a))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (e) {
      console.error("Acknowledge failed:", e);
    }
  };

  const handleBatchAcknowledge = async () => {
    const ids = Array.from(selectedAlerts);
    if (ids.length === 0) return;
    try {
      await api.acknowledgeAlertsBatch(ids);
      setAlerts((prev) =>
        prev.map((a) => (selectedAlerts.has(a.alert_id) ? { ...a, acknowledged: true } : a))
      );
      setUnreadCount((prev) => Math.max(0, prev - ids.length));
      setSelectedAlerts(new Set());
    } catch (e) {
      console.error("Batch acknowledge failed:", e);
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

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Bell}
        feature="Alerts"
        description="Alert rules and the live feed belong to an organization, so create one to start getting notified."
      />
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      <PageHeader
        title="Alert Feed"
        subtitle={loading ? "..." : `${total} alerts · ${unreadCount} unread`}
        icon={Bell}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={fetchAlerts}
              className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          {hasSelection && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={handleBatchAcknowledge}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              Acknowledge {selectedAlerts.size}
            </motion.button>
          )}
          </div>
        }
      />

      {/* Stats Cards */}
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
                "flex items-center gap-3 p-3 rounded-lg border transition-all text-left",
                severityFilter === sev
                  ? cn(config.bg, "border-white/10")
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
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
            rulesOpen
              ? "bg-[var(--accent-faint)] text-[var(--accent)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          )}
        >
          <Megaphone className="w-3.5 h-3.5" />
          Rules
          {rulesOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
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
            <AlertRulesPanel orgId={currentOrg?.id} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-[var(--error)]/20 bg-[var(--error)]/10 text-sm text-[var(--error)] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={fetchAlerts} className="ml-auto text-xs underline">Retry</button>
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
            icon={Bell}
            title="All clear"
            description={
              severityFilter !== "all" || acknowledgedFilter !== null
                ? "No alerts match your current filters. Try clearing the filters to see all alerts."
                : "No active alerts. Eden will surface cost spikes, quality drops, and pipeline failures here as they happen."
            }
            size="lg"
            action={
              severityFilter !== "all" || acknowledgedFilter !== null ? (
                <button
                  onClick={() => {
                    setSeverityFilter("all");
                    setAcknowledgedFilter(null);
                  }}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            {alerts.map((alert) => {
              const config = getSeverityConfig(alert.severity);
              const Icon = config.icon;
              const isExpanded = expandedAlert === alert.alert_id;
              const isSelected = selectedAlerts.has(alert.alert_id);

              return (
                <motion.div
                  key={alert.alert_id}
                  layout
                  initial={false}
                  animate={{ opacity: alert.acknowledged ? 0.6 : 1 }}
                  className={cn(
                    "rounded-lg border transition-all",
                    isSelected ? "border-[var(--accent)]/30 bg-[var(--accent-faint)]/20" : "border-[var(--border-default)] bg-[var(--bg-primary)]",
                    !alert.acknowledged && !isSelected && "hover:border-[var(--border-strong)]"
                  )}
                >
                  <div
                    className="flex items-start gap-3 p-4 cursor-pointer"
                    onClick={() => setExpandedAlert(isExpanded ? null : alert.alert_id)}
                  >
                    {/* Checkbox */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(alert.alert_id);
                      }}
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
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {alert.channels.join(", ")}
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
                          className="p-1.5 text-[var(--text-muted)] hover:text-[var(--success)] hover:bg-[var(--success-bg)] rounded-lg transition-colors"
                          title="Acknowledge"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                      >
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Detail */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 pt-0 border-t border-[var(--border-default)]">
                          <div className="pt-3 space-y-2">
                            <DetailRow label="Alert ID" value={alert.alert_id} />
                            <DetailRow label="Entity" value={alert.entity_id} />
                            <DetailRow label="Severity" value={alert.severity} />
                            <DetailRow label="Created" value={new Date(alert.created_at).toLocaleString()} />
                            <DetailRow label="Channels" value={alert.channels.join(", ") || "—"} />
                            <DetailRow label="Status" value={alert.acknowledged ? "Acknowledged" : "Unread"} />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
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
    </div>
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

function AlertRulesPanel({ orgId }: { orgId?: string }) {
  const [rules, setRules] = useState<Array<{
    rule_id: string;
    name: string;
    description: string;
    event_types: string[];
    severity_threshold: string;
    channels: string[];
    enabled: boolean;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) return;
    api.getAlertRules(orgId)
      .then((data) => setRules(data.rules))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [orgId]);

  if (loading) {
    return (
      <div className="p-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)]">
        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
        <Megaphone className="w-4 h-4 text-[var(--accent)]" />
        Active Alert Rules
      </h3>
      <div className="space-y-2">
        {rules.map((rule) => {
          const sevConfig = getSeverityConfig(rule.severity_threshold);
          return (
            <div
              key={rule.rule_id}
              className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-tertiary)]/50"
            >
              <div className={cn("p-1.5 rounded-md flex-shrink-0", sevConfig.bg)}>
                <sevConfig.icon className={cn("w-3.5 h-3.5", sevConfig.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{rule.name}</span>
                  <span className={cn("px-1.5 py-0.5 text-[10px] font-bold uppercase rounded", sevConfig.bg, sevConfig.color)}>
                    {sevConfig.label}
                  </span>
                  {!rule.enabled && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-[var(--bg-muted)] text-[var(--text-muted)] rounded">
                      Disabled
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{rule.description}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {rule.event_types.map((et) => (
                    <span key={et} className="px-1.5 py-0.5 text-[10px] bg-[var(--bg-muted)] text-[var(--text-secondary)] rounded">
                      {et}
                    </span>
                  ))}
                  <span className="text-[10px] text-[var(--text-muted)]">
                    → {rule.channels.join(", ")}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
