"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Bell, Check, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import {
  CoreResourcePage,
  ResourceOsToolbar,
  BulkActionBar,
} from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertRulesSheet } from "./_components/alert-rules-sheet";
import { AlertsSeverityStrip } from "./_components/alerts-severity-strip";
import { AlertsFeed } from "./_components/alerts-feed";
import { AlertsDetailPanel } from "./_components/alerts-detail-panel";
import { useAlertsPage } from "./_components/use-alerts-page";
import {
  getSeverityConfig,
  VERDICT_CONFIG,
  type SeverityFilter,
  type VerdictFilter,
} from "./_components/alert-config";
import {
  preserveFromSearchParams,
  tracesFilteredHref,
} from "@/lib/portal-cross-links";

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
  const a = useAlertsPage();
  const pagePreserve = preserveFromSearchParams(a.searchParams);
  const tracesHubHref = tracesFilteredHref({
    pastHours: pagePreserve?.pastHours,
    q: pagePreserve?.q,
    realm: pagePreserve?.realm,
    outcome: pagePreserve?.outcome,
    agent_id: pagePreserve?.agent_id,
  });

  if (!a.currentOrg) {
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
      value={a.tab}
      onValueChange={(v) => {
        const next = v as "feed" | "signals";
        if (next === "signals") a.setRulesOpen(false);
        a.setTab(next);
      }}
    >
      <CoreResourcePage
        header={
          <PageHeader
            title="Alerts"
            subtitle={
              a.tab === "signals"
                ? "Signals nest here — plain-English metric thresholds that feed notification rules."
                : a.loading
                  ? "..."
                  : `${a.total} alerts · ${a.unreadCount} unread`
            }
            actions={
              a.tab === "feed" ? (
                <div className="flex items-center gap-space-2">
                  <Button
                    variant="ghost"
                    size="default"
                    onClick={a.fetchAlerts}
                    disabled={a.loading || a.refreshing}
                    loading={a.refreshing}
                    aria-label="Refresh alerts"
                    title="Refresh"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  {a.hasSelection ? (
                    <Button
                      size="sm"
                      onClick={() => void a.handleBatchAcknowledge()}
                      disabled={a.ackLoading}
                      aria-label={`Acknowledge ${a.selectedAlerts.size} selected alerts`}
                      className="min-h-11"
                    >
                      {a.ackLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      Acknowledge {a.selectedAlerts.size}
                    </Button>
                  ) : null}
                </div>
              ) : null
            }
          />
        }
        toolbar={
          <div
            className="flex flex-col gap-space-3"
            data-testid="alerts-toolbar"
            data-wave4-alerts="completed"
          >
            <div className="flex flex-wrap items-end gap-space-2">
              <TabsList
                variant="underline"
                aria-label="Alerts sections"
                className="h-auto flex-1 justify-start gap-space-1 bg-transparent"
              >
                <TabsTrigger
                  variant="underline"
                  value="feed"
                  title="Feed"
                  className="min-h-11"
                >
                  Feed
                </TabsTrigger>
              </TabsList>
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
                  {a.tab !== "signals" ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        a.setRulesOpen(false);
                        a.setTab("signals");
                      }}
                      data-testid="alerts-more-signals"
                    >
                      Signals
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => a.setTab("feed")}>
                      Alert feed
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => a.openRules()}
                    data-testid="alerts-more-rules"
                  >
                    Rules
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link
                      href="/settings?tab=security"
                      data-testid="alerts-more-channels"
                    >
                      Channels (Settings)
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/issues?tab=incidents">Incidents</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={tracesHubHref} data-testid="alerts-more-traces">
                      Traces
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {a.tab === "feed" ? (
              <ResourceOsToolbar
                resourceKey="alerts"
                sticky
                onCreateAlert={() => a.openRules()}
                exportRows={a.alerts.map((row) => ({
                  id: row.alert_id,
                  title: row.title,
                  severity: row.severity,
                  acknowledged: row.acknowledged,
                  created_at: row.created_at,
                }))}
                exportFilename="alerts.csv"
                selects={[
                  {
                    key: "severity",
                    label: "Severity",
                    value: a.severityFilter === "all" ? "" : a.severityFilter,
                    options: (
                      ["critical", "high", "warning", "info", "debug"] as const
                    ).map((sev) => ({
                      value: sev,
                      label: `${getSeverityConfig(sev).label}${
                        a.severityCounts[sev]
                          ? ` (${a.severityCounts[sev]})`
                          : ""
                      }`,
                    })),
                  },
                  {
                    key: "ack",
                    label: "Ack state",
                    value:
                      a.acknowledgedFilter === null
                        ? ""
                        : a.acknowledgedFilter
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
                    value: a.verdictFilter === "all" ? "" : a.verdictFilter,
                    options: (
                      [
                        "real_incident",
                        "benign",
                        "duplicate",
                        "pending",
                      ] as const
                    ).map((v) => ({
                      value: v,
                      label: VERDICT_CONFIG[v]?.label ?? v,
                    })),
                  },
                ]}
                onFiltersChange={(next) => {
                  const sev = next.severity?.trim();
                  a.setSeverityFilter(
                    sev && sev !== "all" ? (sev as SeverityFilter) : "all",
                  );
                  const ack = next.ack?.trim();
                  a.setAcknowledgedFilter(
                    ack === "acknowledged"
                      ? true
                      : ack === "unread"
                        ? false
                        : null,
                  );
                  const verdict = next.verdict?.trim();
                  a.setVerdictFilter(
                    verdict && verdict !== "all"
                      ? (verdict as VerdictFilter)
                      : "all",
                  );
                  a.setOffset(0);
                }}
              />
            ) : null}
          </div>
        }
        kpiStrip={
          a.tab === "feed" && !a.loading ? (
            <AlertsSeverityStrip
              severityCounts={a.severityCounts}
              severityFilter={a.severityFilter}
              onSeverityChange={(next) => {
                a.setSeverityFilter(next);
                a.setOffset(0);
              }}
            />
          ) : undefined
        }
        table={
          <AlertsFeed
            alerts={a.alerts}
            triageEvents={a.triageEvents}
            loading={a.loading}
            feedError={a.alertsQuery.error}
            rulesError={a.rulesError}
            rulesReady={a.rulesReady}
            hasAlertRules={a.hasAlertRules}
            rulesFetching={a.rulesQuery.isFetching}
            severityFilter={a.severityFilter}
            acknowledgedFilter={a.acknowledgedFilter}
            verdictFilter={a.verdictFilter}
            selectedAlerts={a.selectedAlerts}
            alertId={a.alertId}
            total={a.total}
            limit={a.limit}
            offset={a.offset}
            onRetryFeed={a.fetchAlerts}
            onRetryRules={() => void a.rulesQuery.refetch()}
            onClearFilters={a.clearFilters}
            onOpenRules={a.openRules}
            onSelectAlert={(id) => a.setUrlState({ alertId: id })}
            onToggleSelect={a.toggleSelect}
            onAcknowledge={(id) => void a.handleAcknowledge(id)}
            onOffsetChange={a.setOffset}
            onOverrideVerdict={(id, v) => void a.onOverrideVerdict(id, v)}
            onRefreshEvents={() => void a.eventsQuery.refetch()}
          />
        }
        detail={
          a.tab === "feed" && a.alertId && a.selectedAlert ? (
            <AlertsDetailPanel
              selectedAlert={a.selectedAlert}
              alertIndex={a.alertIndex}
              alertsLength={a.alerts.length}
              channelConfigured={a.channelConfigured}
              preserve={pagePreserve}
              onClose={() => a.setUrlState({ alertId: undefined })}
              onPrev={
                a.alertIndex > 0
                  ? () =>
                      a.setUrlState({
                        alertId: a.alerts[a.alertIndex - 1]?.alert_id,
                      })
                  : undefined
              }
              onNext={
                a.alertIndex >= 0 && a.alertIndex < a.alerts.length - 1
                  ? () =>
                      a.setUrlState({
                        alertId: a.alerts[a.alertIndex + 1]?.alert_id,
                      })
                  : undefined
              }
              onAcknowledge={(id) => void a.handleAcknowledge(id)}
              onConfigureRules={a.openRules}
            />
          ) : null
        }
        bulkBar={
          a.tab === "feed" ? (
            <BulkActionBar
              count={a.selectedAlerts.size}
              hideOnMobile
              onClear={() => a.setSelectedAlerts(new Set())}
              actions={[
                {
                  label: "Acknowledge",
                  onClick: () => void a.handleBatchAcknowledge(),
                },
              ]}
            />
          ) : null
        }
      />
      <AlertRulesSheet
        open={a.rulesOpen}
        onOpenChange={(open) => {
          a.setRulesOpen(open);
          const params = new URLSearchParams(a.searchParams.toString());
          if (open) params.set("tab", "rules");
          else if (params.get("tab") === "rules") params.delete("tab");
          const qs = params.toString();
          a.router.replace(qs ? `/alerts?${qs}` : "/alerts");
        }}
        orgId={a.currentOrg?.id}
        prefillFilters={{
          realm: a.searchParams.get("realm") || "",
          outcome: a.searchParams.get("outcome") || "",
          agent_id: a.searchParams.get("agent_id") || "",
          pastHours: a.searchParams.get("pastHours") || "",
          q: a.searchParams.get("q") || "",
        }}
      />
    </Tabs>
  );
}
