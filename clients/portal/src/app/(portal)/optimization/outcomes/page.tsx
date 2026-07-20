"use client";

import { useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2, Building2, Sparkles, TrendingUp, Wallet, Target } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/error-state";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { outcomesApi } from "@/lib/api";
import {
  assertOkEnvelope,
  featureGatedErrorCopy,
  featureGatedMessage,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";
import { cn } from "@/lib/utils";

/* ----------------------- Helpers -------------------------------------- */

function formatCurrency(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function roiColor(roi: number | null): string {
  if (roi == null) return "bg-[var(--bg-tertiary)] text-[var(--text-muted)]";
  if (roi >= 2) return "bg-[var(--success-bg)] text-[var(--success)]";
  if (roi >= 1) return "bg-[var(--warning-bg)] text-[var(--warning)]";
  return "bg-[var(--error-bg)] text-[var(--error)]";
}

function labelOutcomeType(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ----------------------- Departments tab ------------------------------ */

/** UI row mapped from BE ``cost_usd`` / ``outcomes_value_usd`` / ``net_roi``. */
type Department = {
  department: string;
  total_cost: number;
  total_revenue: number;
  roi: number | null;
  trace_count: number;
  anomaly: string | null;
};

function DepartmentsTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useOrgQuery(
    queryKeys.outcomes.departments(orgId),
    orgId,
    async () => {
      const res = await outcomesApi.listDepartments(orgId!);
      const payload = assertOkEnvelope(res, "Could not load departments");
      const rows = payload.departments ?? [];
      return rows.map((d) => ({
        department: d.department,
        total_cost: d.cost_usd ?? 0,
        total_revenue: d.outcomes_value_usd ?? 0,
        roi: d.net_roi,
        trace_count: d.outcome_count ?? 0,
        anomaly: d.alert,
      }));
    },
  );
  const departments: Department[] = data ?? [];

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center" role="status" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load departments");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          isRetryableIntelligenceError(error) ? (
            <button
              onClick={() => refetch()}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              Try again
            </button>
          ) : undefined
        }
      />
    );
  }

  const columns: DataTableColumn<Department>[] = [
    { key: "department", header: "Department", cell: (d) => <span className="font-medium text-[var(--text-primary)]">{d.department}</span>, sortable: true },
    { key: "total_cost", header: "Cost", align: "right", cell: (d) => formatCurrency(d.total_cost, { compact: true }), sortable: true },
    { key: "total_revenue", header: "Value", align: "right", cell: (d) => formatCurrency(d.total_revenue, { compact: true }), sortable: true },
    {
      key: "roi",
      header: "ROI",
      align: "right",
      cell: (d) => (
        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", roiColor(d.roi))}>
          {d.roi == null ? "—" : d.roi.toFixed(2)}
        </span>
      ),
      sortable: true,
    },
    { key: "trace_count", header: "Outcomes", align: "right", cell: (d) => d.trace_count.toLocaleString(), sortable: true },
    {
      key: "anomaly",
      header: "Alert",
      cell: (d) =>
        d.anomaly ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--error)]">
            <AlertTriangle className="h-3 w-3" /> low ROI
          </span>
        ) : (
          <span className="text-[var(--text-muted)]">—</span>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departments</CardTitle>
        <CardDescription>Cost, outcome value, and ROI by department</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <DataTable
          columns={columns}
          rows={departments}
          rowKey={(d) => d.department}
          defaultSort={{ key: "roi", direction: "desc" }}
          emptyIcon={Building2}
          emptyTitle="No department data"
          emptyDescription="Track outcomes on traces to populate department ROI."
        />
      </CardContent>
    </Card>
  );
}

/* ----------------------- Track outcome form --------------------------- */

/** Matches BE ``KNOWN_OUTCOME_TYPES`` in ``eden.analytics.outcomes.tracker``. */
const KNOWN_OUTCOME_TYPES = [
  "conversion",
  "lead",
  "revenue",
  "support_deflection",
  "feature_velocity",
  "cost_savings",
  "user_retention",
  "nps_lift",
  "ticket_resolved",
  "document_drafted",
] as const;

const OUTCOME_OPTIONS = KNOWN_OUTCOME_TYPES.map((value) => ({
  value,
  label: labelOutcomeType(value),
}));

function TrackTab() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [traceId, setTraceId] = useState("");
  const [outcomeType, setOutcomeType] = useState<string>(KNOWN_OUTCOME_TYPES[0]);
  const [department, setDepartment] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !traceId.trim()) return;
    const parsedValue = value.trim() ? Number(value) : 0;
    if (Number.isNaN(parsedValue) || parsedValue < 0) {
      toast.error("Invalid value", "Value must be a non-negative number");
      return;
    }
    setSubmitting(true);
    try {
      const res = await outcomesApi.track(currentOrg.id, {
        trace_id: traceId.trim(),
        outcome_type: outcomeType,
        value: parsedValue,
        department: department.trim() || undefined,
      });
      const payload = res.data;
      toast.success(
        "Outcome tracked",
        payload
          ? `${payload.outcome_type} · $${payload.value.toFixed(2)} · ${payload.outcome_id.slice(0, 12)}…`
          : "Saved",
      );
      setTraceId("");
      setDepartment("");
      setValue("");
    } catch (e) {
      toast.error(
        featureGatedMessage(e, "Track failed"),
        featureGatedMessage(e, "Failed to track outcome"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Track outcome</CardTitle>
        <CardDescription>
          Attribute an outcome to a trace to feed department ROI calculations
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Trace ID
              </span>
              <input
                type="text"
                value={traceId}
                onChange={(e) => setTraceId(e.target.value)}
                required
                placeholder="trc_…"
                aria-label="Trace ID"
                aria-required="true"
                disabled={submitting}
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Outcome type
              </span>
              <select
                value={outcomeType}
                onChange={(e) => setOutcomeType(e.target.value)}
                aria-label="Outcome type"
                disabled={submitting}
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
              >
                {OUTCOME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Department
              </span>
              <input
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. support, sales"
                aria-label="Department"
                disabled={submitting}
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Value (USD)
              </span>
              <input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                aria-label="Outcome value in USD"
                disabled={submitting}
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
              />
            </label>
          </div>
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={submitting || !traceId.trim()}
              aria-label="Track outcome"
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                "bg-[var(--accent)] text-[var(--bg-primary)] shadow-sm hover:bg-[var(--accent-hover)]",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              )}
              Track outcome
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ----------------------- Page ---------------------------------------- */

export default function OutcomesPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [tab, setTab] = useState<"departments" | "track">("departments");
  const {
    data: analytics,
    isLoading: analyticsLoading,
    error: analyticsError,
    refetch: refetchAnalytics,
  } = useOrgQuery(
    queryKeys.outcomes.analytics(orgId),
    orgId,
    async () => {
      const res = await outcomesApi.getAnalytics(orgId!);
      const payload = assertOkEnvelope(res, "Could not load outcomes analytics");
      const summary = payload.summary;
      return {
        total_revenue: summary?.total_value_usd ?? 0,
        total_cost: summary?.total_cost_usd ?? 0,
        roi: summary?.net_roi ?? null,
      };
    },
  );

  if (!currentOrg) {
    return <NoOrgState feature="Outcomes" />;
  }

  const analyticsUnavailable = Boolean(analyticsError);
  const analyticsCopy = analyticsError
    ? featureGatedErrorCopy(analyticsError, "Could not load outcomes analytics")
    : null;

  return (
    <PageContent>
      <PageHeader
        eyebrow="Optimize"
        title="Outcomes & ROI"
        subtitle="See which departments are profitable and attribute wins to specific traces."
        icon={Target}
      />
      {analyticsCopy ? (
        <ErrorState
          title={analyticsCopy.title}
          message={analyticsCopy.message}
          action={
            isRetryableIntelligenceError(analyticsError) ? (
              <button
                onClick={() => refetchAnalytics()}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                Try again
              </button>
            ) : undefined
          }
        />
      ) : null}
      {/* KPI strip — em-dash while loading or on error (never false $0) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Total value"
          value={
            analyticsLoading || analyticsUnavailable
              ? "—"
              : formatCurrency(analytics?.total_revenue ?? 0, { compact: true })
          }
          subtitle={
            analyticsUnavailable ? "unavailable" : analyticsLoading ? "Loading…" : "Tracked outcomes"
          }
          icon={TrendingUp}
          accent="terminal"
        />
        <StatCard
          title="Total cost"
          value={
            analyticsLoading || analyticsUnavailable
              ? "—"
              : formatCurrency(analytics?.total_cost ?? 0, { compact: true })
          }
          subtitle={
            analyticsUnavailable ? "unavailable" : analyticsLoading ? "Loading…" : "Attributed"
          }
          icon={Wallet}
          accent="warning"
        />
        <StatCard
          title="ROI"
          value={
            analyticsLoading || analyticsUnavailable
              ? "—"
              : analytics?.roi == null
                ? "—"
                : analytics.roi.toFixed(2)
          }
          subtitle={
            analyticsUnavailable ? "unavailable" : analyticsLoading ? "Loading…" : "Value / cost"
          }
          icon={Sparkles}
          accent={(analytics?.roi ?? 0) >= 1 ? "accent" : "warning"}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "departments" | "track")}>
        <TabsList variant="underline" className="w-full">
          <TabsTrigger value="departments" variant="underline">
            Departments
          </TabsTrigger>
          <TabsTrigger value="track" variant="underline">
            Track outcome
          </TabsTrigger>
        </TabsList>

        <>
          {tab === "departments" && (
            <TabsContent value="departments">
              <div
                key="departments"
              >
                {tab === "departments" && <DepartmentsTab />}
              </div>
            </TabsContent>
          )}
          {tab === "track" && (
            <TabsContent value="track">
              <div
                key="track"
              >
                {tab === "track" && <TrackTab />}
              </div>
            </TabsContent>
          )}
        </>
      </Tabs>
    </PageContent>
  );
}
