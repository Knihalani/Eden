"use client";

import { useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2, Building2, Sparkles, TrendingUp, Wallet, Target } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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

function roiColor(roi: number): string {
  if (roi >= 2) return "bg-[var(--success-bg)] text-[var(--success)]";
  if (roi >= 1) return "bg-[var(--warning-bg)] text-[var(--warning)]";
  return "bg-[var(--error-bg)] text-[var(--error)]";
}

/* ----------------------- Departments tab ------------------------------ */

type Department = { department: string; total_cost: number; total_revenue: number; roi: number; trace_count: number; anomaly: string | null };

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
      return res.departments ?? [];
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
    return (
      <ErrorState
        title="Could not load departments"
        message={error.message}
        action={
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            Try again
          </button>
        }
      />
    );
  }

  const columns: DataTableColumn<Department>[] = [
    { key: "department", header: "Department", cell: (d) => <span className="font-medium text-[var(--text-primary)]">{d.department}</span>, sortable: true },
    { key: "total_cost", header: "Cost", align: "right", cell: (d) => formatCurrency(d.total_cost, { compact: true }), sortable: true },
    { key: "total_revenue", header: "Revenue", align: "right", cell: (d) => formatCurrency(d.total_revenue, { compact: true }), sortable: true },
    {
      key: "roi",
      header: "ROI",
      align: "right",
      cell: (d) => (
        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", roiColor(d.roi))}>
          {d.roi.toFixed(2)}
        </span>
      ),
      sortable: true,
    },
    { key: "trace_count", header: "Traces", align: "right", cell: (d) => d.trace_count.toLocaleString(), sortable: true },
    {
      key: "anomaly",
      header: "Anomaly",
      cell: (d) =>
        d.anomaly ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--error)]">
            <AlertTriangle className="h-3 w-3" /> {d.anomaly}
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
        <CardDescription>Cost, revenue, and ROI by department</CardDescription>
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

const OUTCOME_OPTIONS = [
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "support_resolved", label: "Support resolved" },
  { value: "churned", label: "Churned" },
  { value: "renewed", label: "Renewed" },
  { value: "expanded", label: "Expanded" },
];

function TrackTab() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [traceId, setTraceId] = useState("");
  const [outcome, setOutcome] = useState("won");
  const [department, setDepartment] = useState("");
  const [revenue, setRevenue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !traceId.trim()) return;
    setSubmitting(true);
    try {
      const res = await outcomesApi.track(currentOrg.id, {
        trace_id: traceId.trim(),
        outcome,
        department: department.trim() || undefined,
        revenue: revenue.trim() ? Number(revenue) : undefined,
      });
      toast.success(
        "Outcome tracked",
        `Trace ${res.trace_id.slice(0, 12)}… · ROI ${res.roi.toFixed(2)}`,
      );
      setTraceId("");
      setDepartment("");
      setRevenue("");
    } catch (e) {
      toast.error(
        "Track failed",
        e instanceof Error ? e.message : "Failed to track outcome",
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
                Outcome
              </span>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
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
                Revenue (USD)
              </span>
              <input
                type="number"
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                aria-label="Revenue in USD"
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
  const { data: analytics, isLoading: analyticsLoading } = useOrgQuery(
    queryKeys.outcomes.analytics(orgId),
    orgId,
    async () => {
      const res = await outcomesApi.getAnalytics(orgId!);
      return {
        total_revenue: res.total_revenue ?? 0,
        total_cost: res.total_cost ?? 0,
        roi: res.roi ?? 0,
      };
    },
  );

  if (!currentOrg) {
    return <NoOrgState feature="Outcomes" />;
  }

  return (
    <PageContent>
      <PageHeader
        eyebrow="Optimize"
        title="Outcomes & ROI"
        subtitle="See which departments are profitable and attribute wins to specific traces."
        icon={Target}
      />
      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Total revenue"
          value={analyticsLoading ? "—" : formatCurrency(analytics?.total_revenue ?? 0, { compact: true })}
          subtitle="Tracked outcomes"
          icon={TrendingUp}
          accent="terminal"
        />
        <StatCard
          title="Total cost"
          value={analyticsLoading ? "—" : formatCurrency(analytics?.total_cost ?? 0, { compact: true })}
          subtitle="Attributed"
          icon={Wallet}
          accent="warning"
        />
        <StatCard
          title="ROI"
          value={analyticsLoading ? "—" : (analytics?.roi ?? 0).toFixed(2)}
          subtitle="Revenue / cost"
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

        <AnimatePresence mode="wait">
          {tab === "departments" && (
            <TabsContent value="departments">
              <motion.div
                key="departments"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "departments" && <DepartmentsTab />}
              </motion.div>
            </TabsContent>
          )}
          {tab === "track" && (
            <TabsContent value="track">
              <motion.div
                key="track"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "track" && <TrackTab />}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>
    </PageContent>
  );
}
