"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { TabsContent } from "@/components/ui/tabs";
import { VirtualizedList } from "@/components/portal-os";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { Bell, Check, CheckCircle2, Clock } from "lucide-react";
import {
  getSeverityConfig,
  VERDICT_CONFIG,
  type AlertItem,
  type SeverityFilter,
  type VerdictFilter,
} from "./alert-config";

export interface AlertsFeedProps {
  alerts: AlertItem[];
  triageEvents: Array<{
    id: string;
    title: string;
    triage_verdict?: string | null;
    triage_reason?: string | null;
  }>;
  loading: boolean;
  feedError: Error | null | undefined;
  rulesError: string | null;
  rulesReady: boolean;
  hasAlertRules: boolean;
  rulesFetching: boolean;
  severityFilter: SeverityFilter;
  acknowledgedFilter: boolean | null;
  verdictFilter: VerdictFilter;
  selectedAlerts: Set<string>;
  alertId?: string;
  total: number;
  limit: number;
  offset: number;
  onRetryFeed: () => void;
  onRetryRules: () => void;
  onClearFilters: () => void;
  onOpenRules: () => void;
  onSelectAlert: (id: string | undefined) => void;
  onToggleSelect: (id: string) => void;
  onAcknowledge: (id: string) => void;
  onOffsetChange: (next: number) => void;
  onOverrideVerdict: (id: string, verdict: "real_incident" | "benign") => void;
  onRefreshEvents: () => void;
}

export function AlertsFeed(props: AlertsFeedProps) {
  const {
    alerts,
    triageEvents,
    loading,
    feedError,
    rulesError,
    rulesReady,
    hasAlertRules,
    rulesFetching,
    severityFilter,
    acknowledgedFilter,
    verdictFilter,
    selectedAlerts,
    alertId,
    total,
    limit,
    offset,
    onRetryFeed,
    onRetryRules,
    onClearFilters,
    onOpenRules,
    onSelectAlert,
    onToggleSelect,
    onAcknowledge,
    onOffsetChange,
    onOverrideVerdict,
  } = props;

  const hasFilters =
    severityFilter !== "all" ||
    acknowledgedFilter !== null ||
    verdictFilter !== "all";

  return (
    <>
      <TabsContent value="signals" className="mt-0">
        <EmptyState
          title="Signals"
          description="Signals live on the Alerts hub."
          action={
            <Button asChild variant="secondary">
              <Link href="/alerts?tab=signals">Open Signals</Link>
            </Button>
          }
        />
      </TabsContent>
      <TabsContent value="feed" className="mt-0 space-y-space-4">
      {/* Triage events (F81) — collapsed by default so they don't compete with the feed */}
      {triageEvents.length > 0 && (
        <details className="group border-b border-[var(--border-subtle)]">
          <summary className="cursor-pointer list-none py-space-2 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            Triage feed ({triageEvents.length})
          </summary>
          <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
          {triageEvents.map((ev) => {
            const verdictCfg = VERDICT_CONFIG[ev.triage_verdict || "pending"] || VERDICT_CONFIG.pending;
            return (
              <div
                key={ev.id}
                className="py-space-3"
              >
                <div className="mb-space-1 flex items-center gap-space-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{ev.title}</span>
                  <span className={cn("text-xs font-bold uppercase", verdictCfg.color)}>
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
                        void onOverrideVerdict(ev.id, "real_incident");
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
                        void onOverrideVerdict(ev.id, "benign");
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
        </details>
      )}

      {/* Alert List */}
      <div className="space-y-space-2">
        <QueryState
          loading={loading && alerts.length === 0}
          error={feedError}
          data={alerts}
          onRetry={onRetryFeed}
          errorTitle="Could not load alerts"
          isEmpty={(d) => d.length === 0}
          loadingSlot={<LoadingSkeleton variant="table" lines={5} className="p-0 max-w-none" />}
          emptySlot={
            rulesError && !hasFilters ? (
              <ErrorState
                title="Could not verify alert rules"
                message={rulesError}
                action={
                  <Button
                    onClick={() => void onRetryRules()}
                    variant="outline"
                    size="sm"
                    loading={rulesFetching}
                    data-testid="alerts-rules-retry"
                  >
                    Try again
                  </Button>
                }
              />
            ) : hasFilters ? (
              <div data-testid="alerts-filtered-empty">
                <EmptyState
                  variant="plain"
                  icon={Bell}
                  title="No alerts match"
                  description={U20_FILTER_EMPTY_COPY.alerts}
                  size="lg"
                  action={
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => {
                        onClearFilters();
                      }}
                      data-testid="alerts-clear-filters"
                    >
                      Clear filters
                    </Button>
                  }
                />
              </div>
            ) : (
              <div data-testid="alerts-empty">
                <EmptyState
                  variant="plain"
                  icon={Bell}
                  title={
                    !rulesReady
                      ? "Checking alert rules…"
                      : hasAlertRules
                        ? "All clear"
                        : "No alert rules yet"
                  }
                  description={
                    !rulesReady
                      ? "Confirming whether notification rules exist before treating an empty feed as healthy."
                      : hasAlertRules
                        ? U20_EMPTY_COPY.alertsClear
                        : U20_EMPTY_COPY.alerts
                  }
                  size="lg"
                  action={
                    !rulesReady ? null : (
                      <Button
                        type="button"
                        onClick={() => {
                          onOpenRules();
                        }}
                        className="min-h-11"
                        data-testid="alerts-create-rule-cta"
                      >
                        Create rule
                      </Button>
                    )
                  }
                />
              </div>
            )
          }
        >
          {() => (
            <>
            <VirtualizedList
              items={alerts}
              rowKey={(alert) => alert.alert_id}
              rowHeight={88}
              className="divide-y divide-[var(--border-subtle)]"
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
                    "row-select-highlight flex w-full items-start gap-space-3 px-space-3 py-space-3 transition-colors hover:bg-[var(--bg-secondary)]",
                    isSelected || isActive
                      ? "is-selected bg-[var(--accent-faint)]/40 ring-1 ring-[var(--accent)]/30"
                      : undefined,
                  )}
                >
                  <div
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-space-3"
                    onClick={() =>
                      onSelectAlert(isActive ? undefined : alert.alert_id)
                    }
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect(alert.alert_id);
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

                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", config.color)} aria-hidden />

                    <div className="min-w-0 flex-1">
                      <div className="mb-space-1 flex flex-wrap items-center gap-space-2">
                        <span className={cn("text-sm font-semibold", alert.acknowledged ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]")}>
                          {alert.title}
                        </span>
                        <span className={cn("text-xs font-bold uppercase", config.color)}>
                          {config.label}
                        </span>
                        {!alert.acknowledged && (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
                        )}
                      </div>
                      <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{alert.message}</p>
                      <div className="mt-space-2 flex items-center gap-space-3">
                        <span className="flex items-center gap-space-1 text-xs text-[var(--text-muted)]">
                          <Clock className="h-3 w-3" aria-hidden />
                          {formatRelativeTime(alert.created_at)}
                        </span>
                        {alert.entity_id && (
                          <span className="font-mono text-xs text-[var(--text-muted)]">
                            {alert.entity_id.slice(0, 12)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-space-1">
                    {!alert.acknowledged && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onAcknowledge(alert.alert_id);
                        }}
                        aria-label={`Acknowledge alert: ${alert.title}`}
                        title="Acknowledge"
                        className="min-h-11 min-w-11"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
              }}
            </VirtualizedList>

            {total > limit && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOffsetChange(Math.max(0, offset - limit))}
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
                  onClick={() => onOffsetChange(offset + limit)}
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
  );
}
