"use client";

/**
 * Dashboard detail page — widget grid + manual widget builder (W3-10).
 *
 * Widget types supported in v1:
 *  - stat   : single KPI number (default for summary: queries)
 *  - line   : area/line chart (future SQL series; falls back to stat)
 *  - bar    : bar chart (future SQL series; falls back to stat)
 *
 * Metric sources (preset summary queries):
 *  - summary:traces        → trace volume 24h
 *  - summary:cost          → cost USD 24h
 *  - summary:eval_pass_rate → eval pass rate 7d
 *  - summary:issues        → open issues
 */

import {
  useState,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  BarChart2,
  Plus,
  Trash2,
  ChevronLeft,
  BarChart,
  LineChart,
  Hash,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart as ReBarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { PageHeader } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { wave6Api, type DashboardWidget } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";

// ── Constants ─────────────────────────────────────────────────────────────

const METRIC_OPTIONS = [
  { value: "summary:traces", label: "Trace volume (24h)" },
  { value: "summary:cost", label: "Cost USD (24h)" },
  { value: "summary:eval_pass_rate", label: "Eval pass rate (7d)" },
  { value: "summary:issues", label: "Open issues" },
] as const;

const CHART_TYPES = [
  { value: "stat", label: "Stat tile", Icon: Hash },
  { value: "bar", label: "Bar", Icon: BarChart },
  { value: "line", label: "Line", Icon: LineChart },
] as const;

const tipStyle = {
  background: "var(--bg)",
  border: "1px solid var(--line)",
  borderRadius: 0,
  fontSize: 12,
};

// ── Widget value fetcher ───────────────────────────────────────────────────

function useWidgetValue(
  orgId: string | null | undefined,
  widget: DashboardWidget,
) {
  return useOrgQuery(
    ["widget-value", orgId, widget.id, widget.query, widget.config?.agent_id],
    orgId,
    () =>
      wave6Api.executeWidgetQuery(orgId!, {
        query: widget.query,
        agent_id: widget.config?.agent_id as string | undefined,
      }),
    { staleTime: 30_000 },
  );
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatWidgetValue(
  query: string,
  value: number | null | undefined,
): string {
  if (value == null) return "—";
  if (query.includes("cost")) return `$${Number(value).toFixed(4)}`;
  if (query.includes("eval_pass_rate"))
    return `${(Number(value) * 100).toFixed(1)}%`;
  return String(Math.round(Number(value)));
}

function widgetLabel(query: string): string {
  const opt = METRIC_OPTIONS.find((o) => o.value === query);
  return opt?.label ?? query;
}

// ── Stat tile ─────────────────────────────────────────────────────────────

function StatTile({
  widget,
  orgId,
  onDelete,
}: {
  widget: DashboardWidget;
  orgId: string;
  onDelete: () => void;
}) {
  const { data, isLoading } = useWidgetValue(orgId, widget);
  const result = (data as { data?: { result?: { value?: number | null } } })
    ?.data?.result;
  const value = result?.value;
  const displayValue = isLoading ? "…" : formatWidgetValue(widget.query, value);

  return (
    <article
      className="group relative flex min-h-[8rem] flex-col justify-between border border-[var(--line)] bg-[var(--bg)] p-5"
      aria-label={widget.title}
    >
      <button
        type="button"
        className="absolute right-3 top-3 hidden rounded-sm p-1 text-[var(--text-faint)] hover:bg-[var(--bg-inset)] hover:text-[var(--error)] group-hover:flex"
        aria-label={`Delete widget ${widget.title}`}
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
      <p className="type-meta text-[var(--text-secondary)]">{widget.title}</p>
      <p className="type-value mt-2 text-3xl tabular-nums text-[var(--text)]">
        {displayValue}
      </p>
      <p className="type-meta mt-1 text-[var(--text-tertiary)]">
        {widgetLabel(widget.query)}
      </p>
    </article>
  );
}

// ── Bar chart widget ───────────────────────────────────────────────────────

function BarWidget({
  widget,
  orgId,
  onDelete,
}: {
  widget: DashboardWidget;
  orgId: string;
  onDelete: () => void;
}) {
  const { data, isLoading } = useWidgetValue(orgId, widget);
  const result = (data as { data?: { result?: { value?: number | null } } })
    ?.data?.result;
  const value = result?.value;
  const chartData =
    value != null
      ? [{ name: widget.title, value: Number(value) }]
      : [];

  return (
    <article
      className="group relative flex min-h-[12rem] flex-col border border-[var(--line)] bg-[var(--bg)] p-5"
      aria-label={widget.title}
    >
      <button
        type="button"
        className="absolute right-3 top-3 hidden rounded-sm p-1 text-[var(--text-faint)] hover:bg-[var(--bg-inset)] hover:text-[var(--error)] group-hover:flex"
        aria-label={`Delete widget ${widget.title}`}
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
      <p className="type-meta mb-3 text-[var(--text-secondary)]">
        {widget.title}
      </p>
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="type-meta text-[var(--text-faint)]">Loading…</span>
        </div>
      ) : chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={140}>
          <ReBarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
              axisLine={{ stroke: "var(--line)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip contentStyle={tipStyle} />
            <Bar dataKey="value" fill="var(--text)" fillOpacity={0.85} radius={[2, 2, 0, 0]} />
          </ReBarChart>
        </ResponsiveContainer>
      ) : (
        <p className="type-meta text-center text-[var(--text-faint)]">No data</p>
      )}
    </article>
  );
}

// ── Line chart widget ──────────────────────────────────────────────────────

function LineWidget({
  widget,
  orgId,
  onDelete,
}: {
  widget: DashboardWidget;
  orgId: string;
  onDelete: () => void;
}) {
  const { data, isLoading } = useWidgetValue(orgId, widget);
  const result = (data as { data?: { result?: { value?: number | null } } })
    ?.data?.result;
  const value = result?.value;
  const chartData =
    value != null ? [{ name: widget.title, value: Number(value) }] : [];

  return (
    <article
      className="group relative flex min-h-[12rem] flex-col border border-[var(--line)] bg-[var(--bg)] p-5"
      aria-label={widget.title}
    >
      <button
        type="button"
        className="absolute right-3 top-3 hidden rounded-sm p-1 text-[var(--text-faint)] hover:bg-[var(--bg-inset)] hover:text-[var(--error)] group-hover:flex"
        aria-label={`Delete widget ${widget.title}`}
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
      <p className="type-meta mb-3 text-[var(--text-secondary)]">
        {widget.title}
      </p>
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="type-meta text-[var(--text-faint)]">Loading…</span>
        </div>
      ) : chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
              axisLine={{ stroke: "var(--line)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip contentStyle={tipStyle} />
            <Area
              type="monotone"
              dataKey="value"
              stroke="var(--text)"
              fill="var(--text)"
              fillOpacity={0.12}
              strokeWidth={1.5}
              isAnimationActive
              animationDuration={180}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <p className="type-meta text-center text-[var(--text-faint)]">No data</p>
      )}
    </article>
  );
}

// ── Widget card (dispatcher) ───────────────────────────────────────────────

function WidgetCard({
  widget,
  orgId,
  onDelete,
}: {
  widget: DashboardWidget;
  orgId: string;
  onDelete: () => void;
}) {
  const chartType = (widget.config?.chart_type as string | undefined) ?? "stat";
  if (chartType === "bar") {
    return <BarWidget widget={widget} orgId={orgId} onDelete={onDelete} />;
  }
  if (chartType === "line") {
    return <LineWidget widget={widget} orgId={orgId} onDelete={onDelete} />;
  }
  return <StatTile widget={widget} orgId={orgId} onDelete={onDelete} />;
}

// ── Widget builder dialog ──────────────────────────────────────────────────

function WidgetBuilderDialog({
  orgId,
  dashboardId,
  existingCount,
  onClose,
  onAdded,
}: {
  orgId: string;
  dashboardId: string;
  existingCount: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState<string>(METRIC_OPTIONS[0].value);
  const [chartType, setChartType] = useState<"stat" | "line" | "bar">("stat");
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState<string>(METRIC_OPTIONS[0].label);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Auto-fill title when metric changes
  const handleQueryChange = useCallback((v: string) => {
    setQuery(v);
    const opt = METRIC_OPTIONS.find((o) => o.value === v);
    if (opt) setTitle(opt.label as string);
  }, []);

  const mutation = useOrgMutation(
    async (body: {
      query: string;
      chartType: "stat" | "line" | "bar";
      agentId: string;
      title: string;
      position: number;
    }) => {
      return wave6Api.upsertWidget(orgId, dashboardId, {
        widget_type: "metric",
        title: body.title,
        query: body.query,
        config: {
          chart_type: body.chartType,
          ...(body.agentId ? { agent_id: body.agentId } : {}),
        },
        position: body.position,
      });
    },
    {
      invalidateKeys: [queryKeys.dashboards.detail(orgId, dashboardId)],
      onSuccess: () => onAdded(),
      onError: (err) => setSubmitError(err.message ?? "Failed to add widget"),
    },
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    mutation.mutate({
      query,
      chartType,
      agentId: agentId.trim(),
      title: title.trim() || widgetLabel(query),
      position: existingCount,
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add widget"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="w-full max-w-md border border-[var(--line)] bg-[var(--bg)] p-6 shadow-lg"
        onSubmit={handleSubmit}
      >
        <h2 className="type-ui mb-5 text-[var(--text)]">Add widget</h2>

        {/* Metric source */}
        <fieldset className="mb-4">
          <legend className="type-meta mb-2 text-[var(--text-secondary)]">
            Metric source
          </legend>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {METRIC_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={[
                  "flex cursor-pointer items-center gap-2.5 border px-3 py-2.5 transition-colors",
                  query === opt.value
                    ? "border-[var(--text)] bg-[var(--bg-inset)]"
                    : "border-[var(--line)] hover:bg-[var(--accent-muted)]",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="metric"
                  value={opt.value}
                  checked={query === opt.value}
                  onChange={() => handleQueryChange(opt.value)}
                  className="sr-only"
                />
                <BarChart2 className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" aria-hidden />
                <span className="type-meta text-[var(--text)]">{opt.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Chart type */}
        <fieldset className="mb-4">
          <legend className="type-meta mb-2 text-[var(--text-secondary)]">
            Chart type
          </legend>
          <div className="flex gap-2">
            {CHART_TYPES.map(({ value, label, Icon }) => (
              <label
                key={value}
                className={[
                  "flex flex-1 cursor-pointer flex-col items-center gap-1.5 border px-3 py-2.5 transition-colors",
                  chartType === value
                    ? "border-[var(--text)] bg-[var(--bg-inset)]"
                    : "border-[var(--line)] hover:bg-[var(--accent-muted)]",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="chart_type"
                  value={value}
                  checked={chartType === value}
                  onChange={() => setChartType(value as "stat" | "line" | "bar")}
                  className="sr-only"
                />
                <Icon className="h-4 w-4 text-[var(--text-faint)]" aria-hidden />
                <span className="type-meta text-[var(--text)]">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Title */}
        <div className="mb-4">
          <label className="type-meta mb-1.5 block text-[var(--text-secondary)]">
            Widget title
          </label>
          <input
            className="ds-input w-full"
            placeholder={widgetLabel(query)}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Agent filter */}
        <div className="mb-5">
          <label className="type-meta mb-1.5 block text-[var(--text-secondary)]">
            Agent filter{" "}
            <span className="text-[var(--text-faint)]">(optional)</span>
          </label>
          <input
            className="ds-input w-full"
            placeholder="agent-id or slug"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          />
          <p className="type-meta mt-1 text-[var(--text-faint)]">
            Narrows eval pass rate to a single agent.
          </p>
        </div>

        {submitError ? (
          <p className="type-meta mb-3 text-[var(--error)]">{submitError}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Adding…" : "Add widget"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Main page component ────────────────────────────────────────────────────

export default function DashboardDetailClient({
  dashboardId,
}: {
  dashboardId: string;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const [showBuilder, setShowBuilder] = useState(false);

  const dashQuery = useOrgQuery(
    queryKeys.dashboards.detail(orgId, dashboardId),
    orgId,
    () => wave6Api.getDashboard(orgId!, dashboardId),
  );

  const dash = (
    dashQuery.data as {
      data?: {
        dashboard?: { name?: string; widgets?: DashboardWidget[] };
      };
    }
  )?.data?.dashboard;

  const widgets: DashboardWidget[] = dash?.widgets ?? [];

  const deleteMutation = useOrgMutation(
    async (widgetId: string) => {
      await wave6Api.deleteWidget(orgId!, dashboardId, widgetId);
    },
    {
      invalidateKeys: [queryKeys.dashboards.detail(orgId, dashboardId)],
    },
  );

  // Close builder and refetch on add
  const handleWidgetAdded = useCallback(() => {
    setShowBuilder(false);
    void dashQuery.refetch();
  }, [dashQuery]);

  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader
        title={dash?.name ?? "Dashboard"}
        meta={
          <Link
            href="/dashboards"
            className="type-meta flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text)]"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Dashboards
          </Link>
        }
        actions={
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => setShowBuilder(true)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add widget
          </button>
        }
      />

      {dashQuery.isLoading ? (
        <QueryLoadingPanel label="Loading dashboard…" />
      ) : dashQuery.isError ? (
        <QueryErrorPanel
          error={dashQuery.error}
          onRetry={() => dashQuery.refetch()}
        />
      ) : widgets.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-5 py-16 text-center">
          <BarChart2 className="h-8 w-8 text-[var(--text-faint)]" aria-hidden />
          <p className="type-body text-[var(--text-secondary)]">
            No widgets yet. Click "Add widget" to build your first chart.
          </p>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => setShowBuilder(true)}
          >
            Add widget
          </button>
        </div>
      ) : (
        <div className="grid gap-px border-t border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-3">
          {widgets.map((w) =>
            orgId ? (
              <WidgetCard
                key={w.id}
                widget={w}
                orgId={orgId}
                onDelete={() => deleteMutation.mutate(w.id)}
              />
            ) : null,
          )}
        </div>
      )}

      {showBuilder && orgId ? (
        <WidgetBuilderDialog
          orgId={orgId}
          dashboardId={dashboardId}
          existingCount={widgets.length}
          onClose={() => setShowBuilder(false)}
          onAdded={handleWidgetAdded}
        />
      ) : null}
    </div>
  );
}
