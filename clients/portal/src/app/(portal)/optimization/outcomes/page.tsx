"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2, Building2, Sparkles, TrendingUp, Wallet } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { useOrg } from "@/hooks/use-org";
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

function DepartmentsTab() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [departments, setDepartments] = useState<
    Array<{ department: string; total_cost: number; total_revenue: number; roi: number; trace_count: number; anomaly: string | null }>
  >([]);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    outcomesApi
      .listDepartments(currentOrg.id)
      .then((res: { departments?: Array<{ department: string; total_cost: number; total_revenue: number; roi: number; trace_count: number; anomaly: string | null }> }) => {
        if (cancelled) return;
        setDepartments(res.departments ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load departments");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState icon={AlertTriangle} title="Could not load departments" description={error} size="md" />
    );
  }

  if (departments.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No department data"
        description="Track outcomes on traces to populate department ROI."
        size="md"
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departments</CardTitle>
        <CardDescription>Cost, revenue, and ROI by department</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-right">Traces</TableHead>
              <TableHead>Anomaly</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((d) => (
              <TableRow key={d.department}>
                <TableCell className="font-medium text-[var(--text-primary)]">
                  {d.department}
                </TableCell>
                <TableCell className="text-right text-[var(--text-primary)]">
                  {formatCurrency(d.total_cost, { compact: true })}
                </TableCell>
                <TableCell className="text-right text-[var(--text-primary)]">
                  {formatCurrency(d.total_revenue, { compact: true })}
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                      roiColor(d.roi)
                    )}
                  >
                    {d.roi.toFixed(2)}
                  </span>
                </TableCell>
                <TableCell className="text-right text-[var(--text-secondary)]">
                  {d.trace_count.toLocaleString()}
                </TableCell>
                <TableCell>
                  {d.anomaly ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--error)]">
                      <AlertTriangle className="h-3 w-3" /> {d.anomaly}
                    </span>
                  ) : (
                    <span className="text-[var(--text-muted)]">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
  const [traceId, setTraceId] = useState("");
  const [outcome, setOutcome] = useState("won");
  const [department, setDepartment] = useState("");
  const [revenue, setRevenue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !traceId.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await outcomesApi.track(currentOrg.id, {
        trace_id: traceId.trim(),
        outcome,
        department: department.trim() || undefined,
        revenue: revenue.trim() ? Number(revenue) : undefined,
      });
      setFeedback({
        kind: "success",
        message: `Tracked outcome on ${res.trace_id.slice(0, 12)}… ROI: ${res.roi.toFixed(2)}`,
      });
      setTraceId("");
      setDepartment("");
      setRevenue("");
    } catch (e) {
      setFeedback({
        kind: "error",
        message: e instanceof Error ? e.message : "Failed to track outcome",
      });
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
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Outcome
              </span>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
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
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
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
                className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <button
              type="submit"
              disabled={submitting || !traceId.trim()}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                "bg-[var(--accent)] text-[var(--bg-primary)] shadow-sm hover:bg-[var(--accent-hover)]",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Track outcome
            </button>
            <AnimatePresence>
              {feedback && (
                <motion.span
                  initial={{ opacity: 0, x: 4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className={cn(
                    "text-xs",
                    feedback.kind === "success"
                      ? "text-[var(--success)]"
                      : "text-[var(--error)]"
                  )}
                >
                  {feedback.message}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ----------------------- Page ---------------------------------------- */

export default function OutcomesPage() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useState<"departments" | "track">("departments");
  const [analytics, setAnalytics] = useState<{
    total_revenue: number;
    total_cost: number;
    roi: number;
  } | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setAnalyticsLoading(true);
    });
    outcomesApi
      .getAnalytics(currentOrg.id)
      .then((res: { total_revenue?: number; total_cost?: number; roi?: number }) => {
        if (cancelled) return;
        setAnalytics({
          total_revenue: res.total_revenue ?? 0,
          total_cost: res.total_cost ?? 0,
          roi: res.roi ?? 0,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAnalytics({ total_revenue: 0, total_cost: 0, roi: 0 });
      })
      .finally(() => {
        if (!cancelled) setAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  if (!currentOrg) {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] p-8 text-center text-sm text-[var(--text-muted)]">
        Select an organization to view outcomes.
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
    </div>
  );
}
