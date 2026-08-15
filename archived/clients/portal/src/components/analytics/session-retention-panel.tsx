"use client";

/**
 * Session cohort retention panel (FEAT-139).
 *
 * Fetches ``GET /orgs/{org}/analytics/cohorts`` (backed by
 * ``session_summaries`` via ``eden.analytics.cohorts``) and renders the
 * code-split RetentionCurveChart island. ChartCard chrome + CSV export
 * mirror gateway-charts.tsx.
 */

import dynamic from "next/dynamic";
import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import { EmptyState } from "@/lab/lab-ui";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  analyticsApi,
  type CohortRetentionRow,
} from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { downloadCsv, downloadPng } from "@/lib/export";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { useOrg } from "@/hooks/use-org";

const RetentionCurveChart = dynamic(
  () =>
    import("./retention-curve-chart").then((m) => ({
      default: m.RetentionCurveChart,
    })),
  {
    ssr: false,
    loading: () => <QueryLoadingPanel label="Loading chart…" />,
  },
);

const DEFAULT_WEEKS = 8;

function ChartCard({
  title,
  hint,
  children,
  onExportCsv,
  onExportPng,
  chartRef,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  onExportCsv?: () => void;
  onExportPng?: () => void;
  chartRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h2 className="type-ui">{title}</h2>
          {hint ? <p className="type-meta mt-0.5">{hint}</p> : null}
        </div>
        <div className="flex gap-1">
          {onExportCsv ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !rounded-none"
              onClick={onExportCsv}
            >
              CSV
            </button>
          ) : null}
          {onExportPng ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !rounded-none"
              onClick={onExportPng}
            >
              PNG
            </button>
          ) : null}
        </div>
      </div>
      <div ref={chartRef}>{children}</div>
    </section>
  );
}

function retentionExportRows(cohorts: CohortRetentionRow[]) {
  return cohorts.map((c) => {
    const row: Record<string, string | number> = {
      cohort: c.cohort,
      start_date: c.start_date,
      size: c.size,
    };
    for (const [week, frac] of Object.entries(c.retention)) {
      row[`w${week}_pct`] = Math.round(frac * 10000) / 100;
    }
    return row;
  });
}

export function SessionRetentionPanel({
  weeks = DEFAULT_WEEKS,
}: {
  weeks?: number;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const chartRef = useRef<HTMLDivElement | null>(null);

  const cohortsQuery = useOrgQuery(
    queryKeys.analytics.cohorts(orgId, weeks),
    orgId,
    () => analyticsApi.cohorts(orgId!, weeks),
    SHELL_QUERY,
  );

  const cohorts = useMemo(
    () => cohortsQuery.data?.cohorts ?? [],
    [cohortsQuery.data],
  );

  if (cohortsQuery.isLoading) {
    return <QueryLoadingPanel label="Loading cohort retention…" />;
  }

  if (cohortsQuery.isError) {
    return (
      <QueryErrorPanel
        error={cohortsQuery.error}
        onRetry={() => void cohortsQuery.refetch()}
      />
    );
  }

  if (cohorts.length === 0) {
    return (
      <EmptyState
        title="No cohort retention yet"
        body="Retention curves appear once users have sessions across multiple weeks."
        compact
      />
    );
  }

  return (
    <ChartCard
      title="Cohort retention"
      hint={`Weekly return rate for the last ${weeks} cohort weeks (session_summaries).`}
      chartRef={chartRef}
      onExportCsv={() =>
        downloadCsv(`eden-cohort-retention-${weeks}w.csv`, retentionExportRows(cohorts))
      }
      onExportPng={async () => {
        if (!chartRef.current) return;
        const bg =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--bg")
            .trim() || "#000000";
        await downloadPng(`eden-cohort-retention-${weeks}w.png`, chartRef.current, {
          backgroundColor: bg,
        });
      }}
    >
      <RetentionCurveChart cohorts={cohorts} />
    </ChartCard>
  );
}
