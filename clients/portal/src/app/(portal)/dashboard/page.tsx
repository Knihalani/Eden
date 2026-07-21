"use client";

import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import { usePagePerf } from "@/lib/perf";
import {
  HOME_KPI_CAP_DESKTOP,
  HOME_KPI_STRIP_CAP,
} from "./_components/home-widgets";
import { HomeDashboardSkeleton } from "./_components/home-dashboard-skeleton";
import { HomeFirstRun } from "./_components/home-first-run";
import { HomeHeaderActions } from "./_components/home-header-actions";
import { HomeKpiStrip } from "./_components/home-kpi-strip";
import { HomeQuietLinks } from "./_components/home-quiet-links";
import { useHomeDashboard } from "./_components/use-home-dashboard";

/**
 * Wave 6 / 7 / 11 — Home = Status → Diagnosis → one Action.
 * Wave 8 — first-run / empty / error / perf / a11y states.
 * Visual redesign allowed (W7); no re-widget / Edit layout.
 */
const WAVE6_HOME_COMPLETED = true as const;
const WAVE7_HOME_COMPOSITION = true as const;
const WAVE8_HOME_STATES = true as const;
const WAVE9_HOME_MOBILE = true as const;
const WAVE11_HOME_PROTECTED = true as const;

/** Lazy islands below the fold — keep first paint lean (Wave 8.4). */
const DiagnosisStrip = dynamic(
  () =>
    import("./_components/diagnosis-strip").then((m) => m.DiagnosisStrip),
  {
    loading: () => (
      <div
        className="h-24 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 animate-pulse"
        aria-busy="true"
        aria-label="Loading diagnosis"
      />
    ),
  },
);
const RecentFailuresCard = dynamic(
  () =>
    import("./_components/recent-failures-card").then(
      (m) => m.RecentFailuresCard,
    ),
  {
    loading: () => (
      <div
        className="h-48 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 animate-pulse"
        aria-busy="true"
        aria-label="Loading recent failures"
      />
    ),
  },
);

/**
 * Layout caps (source of truth: `_components/home-widgets.ts`).
 * HOME_KPI_STRIP_CAP = 4 · locked default order.
 */
void HOME_KPI_CAP_DESKTOP;
void HOME_KPI_STRIP_CAP;
void WAVE6_HOME_COMPLETED;
void WAVE7_HOME_COMPOSITION;
void WAVE8_HOME_STATES;
void WAVE9_HOME_MOBILE;
void WAVE11_HOME_PROTECTED;

export default function DashboardPage() {
  usePagePerf("/dashboard");
  const {
    currentOrg,
    authError,
    orgSyncing,
    orgSyncTimedOut,
    refreshOrgs,
    loading: orgLoading,
  } = useOrg();
  const { hasPermission } = usePermissions();
  const canConnect = hasPermission("integrations:write");
  const canManageKeys = hasPermission("settings:edit");
  const orgId = currentOrg?.id ?? null;

  const d = useHomeDashboard(orgId, orgSyncing);

  if (orgLoading && !currentOrg && !authError) {
    return (
      <HomeDashboardSkeleton label="Loading workspace" />
    );
  }

  if (!currentOrg && !authError) {
    return (
      <div data-home-shell-state="no-org" data-query-state="empty">
        <NoOrgState
          feature="The dashboard"
          syncing={orgSyncing && !orgSyncTimedOut}
          syncTimedOut={orgSyncTimedOut}
          onRetrySync={() => void refreshOrgs()}
          description={
            orgSyncTimedOut
              ? "Workspace sync is taking longer than expected. Refresh to try again — the product tour does not create or sync your workspace."
              : orgSyncing
                ? undefined
                : "Create a workspace to open the dashboard. The product tour does not create or sync your workspace."
          }
        />
      </div>
    );
  }

  const homeState = d.error
    ? "error"
    : d.isFirstRun
      ? "first-run"
      : "ready";

  return (
    <div
      data-wave6-home="completed"
      data-wave7-home="composition"
      data-wave8-home="states"
      data-wave9-home="mobile"
      data-wave11-home="protected"
      data-wave11-mobile="cards"
      data-home-shell-home="status-diagnosis-action"
      data-home-shell-state={homeState}
      data-wave9-mobile="single-column"
      className="min-w-0 w-full max-w-full overflow-x-hidden"
    >
      <CoreResourcePage
        size="wide"
        className="flex flex-col gap-space-4 sm:gap-space-5 min-w-0 max-w-full overflow-x-hidden"
        header={
          <PageHeader
            title="Home"
            subtitle={
              d.isFirstRun
                ? d.firstTraceAt
                  ? FIRST_EVENT_WAIT.descriptionReceived
                  : "No events ingested yet. Install the SDK or gateway, run doctor, then check for events."
                : `Status → diagnosis → next action · ${d.rangeLabel.toLowerCase()}.`
            }
            greeting={
              currentOrg ? `Welcome back to ${currentOrg.name}.` : undefined
            }
            actions={
              <HomeHeaderActions
                isFirstRun={d.isFirstRun}
                canManageKeys={canManageKeys}
                canConnect={canConnect}
                windowHours={d.windowHours}
                onWindowHoursChange={d.setWindowHours}
              />
            }
          />
        }
        table={
          <>
            {d.error ? (
              <div data-query-state="error" data-home-shell-state="error">
                <ErrorState
                  title="Could not load some telemetry."
                  message={d.error}
                  size="sm"
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => {
                        for (const shard of d.failedShards) {
                          void shard.query.refetch();
                        }
                      }}
                    >
                      Retry
                    </Button>
                  }
                />
              </div>
            ) : null}

            {d.isFirstRun ? (
              <HomeFirstRun
                firstTraceAt={d.firstTraceAt}
                canManageKeys={canManageKeys}
                canConnect={canConnect}
                checking={d.tracesQuery.isFetching}
                onCheck={() => {
                  void d.tracesQuery.refetch();
                  void d.firstTraceSignal.refetch();
                }}
              />
            ) : (
              <div
                className="flex flex-col gap-space-4 sm:gap-space-5"
                data-home-shell-state="ready"
                data-query-state="ready"
              >
                <HomeKpiStrip
                  show={d.show}
                  windowHours={d.windowHours}
                  summaryWindowHours={d.summaryWindowHours}
                  summaryLoading={d.summaryLoading}
                  summaryError={d.summaryQuery.isError}
                  avgEps={d.avgEps}
                  throughputTotal={d.throughputTotal}
                  throughputTrend={d.throughputTrend}
                  errorRate={d.errorRate}
                  errorTrend={d.errorTrend}
                  costLoading={d.costLoading}
                  costUnavailable={d.costUnavailable}
                  costEmpty={d.costEmpty}
                  costUsd={(d.costThisMonth ?? 0) / 100}
                  costSubtitle={d.costSubtitle}
                  costTrend={d.costTrend}
                  costDeltaPct={d.costDeltaPct}
                  issuesLoading={d.issuesLoading}
                  issuesUnavailable={d.issuesUnavailable}
                  openIssueCount={d.openIssueCount}
                />

                {d.show("failures") ? (
                  <DiagnosisStrip
                    windowHours={d.windowHours}
                    anomalyCount={d.anomalyCount}
                    severityCounts={d.severityCounts}
                    alertsUnavailable={d.alertsUnavailable}
                    topFailureModes={d.topFailureModes}
                    summaryUnavailable={d.summaryQuery.isError}
                    summaryLoading={d.summaryLoading}
                    openIssueCount={d.openIssueCount ?? 0}
                  />
                ) : null}

                {d.show("traces") ? (
                  <RecentFailuresCard
                    loading={!d.tracesSettled || d.tracesQuery.isLoading}
                    traces={d.windowTraces}
                    unavailable={d.tracesUnavailable}
                    errorMessage={d.tracesErrorMessage}
                  />
                ) : null}

                <HomeQuietLinks />
              </div>
            )}
          </>
        }
      />
    </div>
  );
}
