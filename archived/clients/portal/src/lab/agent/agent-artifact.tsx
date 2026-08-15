"use client";

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
} from "lucide-react";
import { downloadCsv, downloadPng } from "@/lib/export";
import { downloadXlsx } from "@/lib/export-xlsx";
import {
  getStorageColorsResolved,
  STORAGE_COLORS_SSR_FALLBACK,
} from "@/lib/chart-colors";
import type {
  AgentArtifact,
  AgentChartType,
} from "@/lab/fixtures/agent-chat";
import { cn } from "@/lib/utils";

function resolveToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function useChartPalette() {
  return useMemo(() => {
    const pie = getStorageColorsResolved();
    return {
      accent: resolveToken("--chart-accent", "#e8b84a"),
      success: resolveToken("--chart-success", "#4ecf96"),
      error: resolveToken("--chart-error", "#ef4444"),
      grid: resolveToken("--chart-grid", "rgba(255,255,255,0.08)"),
      label: resolveToken("--chart-label", "#a1a1aa"),
      text: resolveToken("--text", "#f4f4f5"),
      bg: resolveToken("--bg", "#0a0a0a"),
      line: resolveToken("--line", "rgba(255,255,255,0.12)"),
      pie: pie.length ? [...pie] : [...STORAGE_COLORS_SSR_FALLBACK],
    };
  }, []);
}

type Palette = ReturnType<typeof useChartPalette>;
type ChartArtifact = Extract<AgentArtifact, { kind: "chart" }>;

function chartRows(artifact: ChartArtifact) {
  return artifact.points.map((p) => ({
    name: p.label,
    value: p.value,
    value2: p.value2 ?? null,
  }));
}

function chartTypeLabel(t: AgentChartType): string {
  return t.replace(/_/g, " ");
}

/** Client-side viz switchers for the same query result. */
function switchableTypes(artifact: ChartArtifact): AgentChartType[] {
  const hasDual = artifact.points.some((p) => p.value2 != null);
  const n = artifact.points.length;
  if (hasDual) return ["composed", "bar", "line"];
  if (n <= 6) {
    return ["bar", "horizontal_bar", "donut", "pie", "radar", "line", "area"];
  }
  return ["bar", "line", "area", "horizontal_bar"];
}

function formatValue(
  value: number,
  unit?: string,
): string {
  if (unit === "$") return `$${value.toFixed(2)}`;
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function summarize(artifact: ChartArtifact) {
  const vals = artifact.points.map((p) => p.value);
  if (vals.length === 0) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const max = Math.max(...vals);
  const maxLabel = artifact.points.find((p) => p.value === max)?.label ?? "";
  return { sum, max, maxLabel, count: vals.length };
}

function ChartTooltip({
  active,
  payload,
  label,
  unit,
  series1,
  series2,
}: {
  active?: boolean;
  payload?: Array<{
    value?: number | string;
    dataKey?: string | number;
    color?: string;
    name?: string;
    payload?: { name?: string };
  }>;
  label?: string;
  unit?: string;
  series1: string;
  series2: string;
}) {
  if (!active || !payload?.length) return null;
  const heading =
    label ||
    payload[0]?.payload?.name ||
    payload[0]?.name ||
    series1;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg)] px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
      <p className="type-label mb-1.5 text-[var(--text)]">{heading}</p>
      <ul className="space-y-1">
        {payload.map((p, i) => {
          const name =
            p.dataKey === "value2" ? series2 : (p.name ?? series1);
          const raw = typeof p.value === "number" ? p.value : Number(p.value);
          if (!Number.isFinite(raw)) return null;
          return (
            <li key={i} className="type-mono flex items-center gap-2 !text-[0.75rem]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: p.color }}
              />
              <span className="text-[var(--text-secondary)]">{name}</span>
              <span className="ml-auto pl-3 text-[var(--text)]">
                {formatValue(raw, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChartBody({
  artifact,
  chartType,
  palette,
  height = 280,
}: {
  artifact: ChartArtifact;
  chartType: AgentChartType;
  palette: Palette;
  height?: number;
}) {
  const data = chartRows(artifact);
  const series1 = artifact.seriesLabel ?? "Value";
  const series2 = artifact.seriesLabel2 ?? "Series 2";
  const tick = { fill: palette.label, fontSize: 11 };
  const margin = { top: 8, right: 12, left: 0, bottom: 0 };
  const tip = (
    <Tooltip
      content={
        <ChartTooltip
          unit={artifact.unit}
          series1={series1}
          series2={series2}
        />
      }
      cursor={{ fill: "rgba(255,255,255,0.04)", stroke: palette.grid }}
    />
  );

  if (chartType === "pie" || chartType === "donut") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="46%"
            innerRadius={chartType === "donut" ? "54%" : 0}
            outerRadius="70%"
            paddingAngle={2}
            stroke={palette.bg}
            strokeWidth={2}
            isAnimationActive
            animationDuration={450}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={palette.pie[i % palette.pie.length]} />
            ))}
          </Pie>
          {tip}
          <Legend
            verticalAlign="bottom"
            height={40}
            wrapperStyle={{ fontSize: 12, color: palette.label }}
          />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "radar") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="66%">
          <PolarGrid stroke={palette.grid} />
          <PolarAngleAxis dataKey="name" tick={tick} />
          <PolarRadiusAxis tick={tick} axisLine={false} />
          <Radar
            name={series1}
            dataKey="value"
            stroke={palette.error}
            fill={palette.error}
            fillOpacity={0.28}
            strokeWidth={2}
            isAnimationActive
          />
          {tip}
          <Legend wrapperStyle={{ fontSize: 12, color: palette.label }} />
        </RadarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "horizontal_bar") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ ...margin, left: 8, right: 16 }}
        >
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={tick} stroke={palette.grid} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            width={80}
            tick={tick}
            stroke={palette.grid}
            axisLine={false}
            tickLine={false}
          />
          {tip}
          <Bar
            dataKey="value"
            name={series1}
            fill={palette.accent}
            radius={[0, 4, 4, 0]}
            maxBarSize={20}
            isAnimationActive
            activeBar={{ fill: palette.text, opacity: 0.85 }}
          />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={margin}>
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={tick} stroke={palette.grid} axisLine={false} tickLine={false} />
          <YAxis tick={tick} stroke={palette.grid} width={46} axisLine={false} tickLine={false} />
          {tip}
          <Legend wrapperStyle={{ fontSize: 12, color: palette.label }} />
          <Line
            type="monotone"
            dataKey="value"
            name={series1}
            stroke={palette.accent}
            strokeWidth={2.25}
            dot={{ r: 3.5, fill: palette.accent, strokeWidth: 0 }}
            activeDot={{ r: 5.5, strokeWidth: 0 }}
            isAnimationActive
          />
          {artifact.points.some((p) => p.value2 != null) ? (
            <Line
              type="monotone"
              dataKey="value2"
              name={series2}
              stroke={palette.success}
              strokeWidth={2.25}
              dot={{ r: 3.5, fill: palette.success, strokeWidth: 0 }}
              isAnimationActive
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "area") {
    const gid = `area-${artifact.id}`;
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={margin}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.accent} stopOpacity={0.45} />
              <stop offset="100%" stopColor={palette.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={tick} stroke={palette.grid} axisLine={false} tickLine={false} />
          <YAxis tick={tick} stroke={palette.grid} width={46} axisLine={false} tickLine={false} />
          {tip}
          <Legend wrapperStyle={{ fontSize: 12, color: palette.label }} />
          <Area
            type="monotone"
            dataKey="value"
            name={series1}
            stroke={palette.accent}
            fill={`url(#${gid})`}
            strokeWidth={2.25}
            isAnimationActive
          />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "composed") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ ...margin, right: 8 }}>
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={tick} stroke={palette.grid} axisLine={false} tickLine={false} />
          <YAxis yAxisId="left" tick={tick} stroke={palette.grid} width={46} axisLine={false} tickLine={false} />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={tick}
            stroke={palette.grid}
            width={46}
            axisLine={false}
            tickLine={false}
          />
          {tip}
          <Legend wrapperStyle={{ fontSize: 12, color: palette.label }} />
          <Bar
            yAxisId="left"
            dataKey="value"
            name={series1}
            fill={palette.accent}
            radius={[4, 4, 0, 0]}
            maxBarSize={34}
            opacity={0.92}
            isAnimationActive
            activeBar={{ fill: palette.text, opacity: 0.9 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="value2"
            name={series2}
            stroke={palette.success}
            strokeWidth={2.25}
            dot={{ r: 3.5, fill: palette.success, strokeWidth: 0 }}
            isAnimationActive
          />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={margin}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="name" tick={tick} stroke={palette.grid} axisLine={false} tickLine={false} />
        <YAxis tick={tick} stroke={palette.grid} width={46} axisLine={false} tickLine={false} />
        {tip}
        <Legend wrapperStyle={{ fontSize: 12, color: palette.label }} />
        <Bar
          dataKey="value"
          name={series1}
          radius={[4, 4, 0, 0]}
          maxBarSize={40}
          isAnimationActive
          activeBar={{ opacity: 1 }}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={palette.pie[i % palette.pie.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartCard({
  artifact,
  palette,
}: {
  artifact: ChartArtifact;
  palette: Palette;
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const types = switchableTypes(artifact);
  const [chartType, setChartType] = useState<AgentChartType>(() =>
    types.includes(artifact.chartType) ? artifact.chartType : types[0]!,
  );
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const stats = summarize(artifact);
  const viewArtifact = useMemo(
    () => ({ ...artifact, chartType }),
    [artifact, chartType],
  );

  async function onPng() {
    if (!captureRef.current || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadPng(
        `${artifact.filename}-${chartType}`,
        captureRef.current,
        { backgroundColor: palette.bg },
      );
      setToast("PNG downloaded");
      window.setTimeout(() => setToast(null), 1800);
    } catch (err) {
      console.warn(err);
      setExportError("PNG export failed — try again");
    } finally {
      setExporting(false);
    }
  }

  function onCsv() {
    downloadCsv(
      `${artifact.filename}-${chartType}`,
      artifact.points.map((p) => {
        const row: Record<string, string | number> = {
          label: p.label,
          value: p.value,
        };
        if (artifact.unit) row.unit = artifact.unit;
        if (p.value2 != null) row.value2 = p.value2;
        return row;
      }),
    );
    setToast("CSV downloaded");
    window.setTimeout(() => setToast(null), 1800);
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <div className="min-w-0 space-y-1">
          <p className="type-ui text-[var(--text)]">{artifact.title}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {artifact.queryId ? (
              <span className="type-mono !text-[0.625rem] !text-[var(--text-faint)]">
                {artifact.queryId}
              </span>
            ) : null}
            {stats ? (
              <span className="type-meta text-[var(--text-secondary)]">
                Peak {formatValue(stats.max, artifact.unit)} · {stats.maxLabel}
                {artifact.unit !== "%" ? (
                  <>
                    {" "}
                    · Σ {formatValue(stats.sum, artifact.unit)}
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "ds-btn ds-btn-ghost ds-btn-sm",
              showTable && "bg-[var(--accent-muted)]",
            )}
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            Data
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-outline ds-btn-sm"
            disabled={exporting}
            aria-busy={exporting}
            onClick={onPng}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {exporting ? "…" : "PNG"}
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onCsv}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </button>
        </div>
      </div>

      <div
        role="toolbar"
        aria-label="Chart type"
        className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-3 py-2"
      >
        {types.map((t) => (
          <button
            key={t}
            type="button"
            className={cn(
              "type-meta shrink-0 rounded-[var(--radius)] px-2.5 py-1 capitalize transition-colors",
              t === chartType
                ? "bg-[var(--accent-muted)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--accent-muted)] hover:text-[var(--text)]",
            )}
            aria-pressed={t === chartType}
            onClick={() => setChartType(t)}
          >
            {chartTypeLabel(t)}
          </button>
        ))}
      </div>

      {exportError ? (
        <p
          role="status"
          aria-live="polite"
          className="type-meta border-b border-[var(--line)] px-4 py-1.5 text-[var(--error)]"
        >
          {exportError}
        </p>
      ) : null}
      {toast ? (
        <p
          role="status"
          aria-live="polite"
          className="type-meta border-b border-[var(--line)] px-4 py-1.5 text-[var(--success)]"
        >
          {toast}
        </p>
      ) : null}

      <div
        ref={captureRef}
        className="bg-[var(--bg)] px-3 pb-4 pt-3"
        style={{ backgroundColor: palette.bg } satisfies CSSProperties}
      >
        <p className="type-ui mb-1 px-1 text-[var(--text)]">{artifact.title}</p>
        <p className="type-meta mb-3 px-1 capitalize text-[var(--text-secondary)]">
          {chartTypeLabel(chartType)}
          {artifact.unit ? ` · ${artifact.unit}` : ""}
        </p>
        <div className="lab-agent-chart h-[280px] w-full">
          <ChartBody
            artifact={viewArtifact}
            chartType={chartType}
            palette={palette}
            height={280}
          />
        </div>
      </div>

      {showTable ? (
        <div className="max-h-48 overflow-auto border-t border-[var(--line)]">
          <table className="w-full min-w-[16rem] border-collapse text-left">
            <thead className="sticky top-0 z-[1] bg-[var(--bg)]">
              <tr>
                <th className="type-label border-b border-[var(--line)] px-3 py-2">
                  Label
                </th>
                <th className="type-label border-b border-[var(--line)] px-3 py-2">
                  {artifact.seriesLabel ?? "Value"}
                </th>
                {artifact.points.some((p) => p.value2 != null) ? (
                  <th className="type-label border-b border-[var(--line)] px-3 py-2">
                    {artifact.seriesLabel2 ?? "Series 2"}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {artifact.points.map((p) => (
                <tr
                  key={p.label}
                  className="border-b border-[var(--line)] last:border-b-0"
                >
                  <td className="type-mono px-3 py-1.5 !text-[0.75rem] !text-[var(--text)]">
                    {p.label}
                  </td>
                  <td className="type-mono px-3 py-1.5 !text-[0.75rem] !text-[var(--text)]">
                    {formatValue(p.value, artifact.unit)}
                  </td>
                  {artifact.points.some((x) => x.value2 != null) ? (
                    <td className="type-mono px-3 py-1.5 !text-[0.75rem] !text-[var(--text)]">
                      {p.value2 != null
                        ? formatValue(p.value2, artifact.unit)
                        : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function SpreadsheetArtifact({
  artifact,
}: {
  artifact: Extract<AgentArtifact, { kind: "spreadsheet" }>;
}) {
  const keys = artifact.columns.map((c) => c.key);
  const [toast, setToast] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg)]">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--line)] px-4 py-3">
        <div className="min-w-0">
          <p className="type-ui flex items-center gap-1.5 text-[var(--text)]">
            <FileSpreadsheet
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]"
              aria-hidden
            />
            {artifact.title}
          </p>
          <p className="type-meta mt-1 text-[var(--text-secondary)]">
            {artifact.rows.length} rows
            {artifact.queryId ? ` · ${artifact.queryId}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => {
              downloadCsv(
                artifact.filename,
                artifact.rows as Record<string, unknown>[],
                keys,
              );
              setToast("CSV downloaded");
              window.setTimeout(() => setToast(null), 1800);
            }}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-outline ds-btn-sm"
            onClick={() => {
              downloadXlsx(
                artifact.filename,
                artifact.rows as Record<string, unknown>[],
                keys,
              );
              setToast("XLSX downloaded");
              window.setTimeout(() => setToast(null), 1800);
            }}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            XLSX
          </button>
        </div>
      </div>
      {toast ? (
        <p
          role="status"
          aria-live="polite"
          className="type-meta border-b border-[var(--line)] px-4 py-1.5 text-[var(--success)]"
        >
          {toast}
        </p>
      ) : null}
      <div className="max-h-64 overflow-auto">
        <table className="w-full min-w-[20rem] border-collapse text-left">
          <thead className="sticky top-0 z-[1] bg-[var(--bg)]">
            <tr>
              {artifact.columns.map((col) => (
                <th
                  key={col.key}
                  className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-[var(--line)] last:border-b-0 hover:bg-[var(--accent-muted)]"
              >
                {artifact.columns.map((col) => (
                  <td
                    key={col.key}
                    className="type-mono px-3 py-2 !text-[0.75rem] !text-[var(--text)] whitespace-nowrap"
                  >
                    {String(row[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChartGallery({
  charts,
  palette,
}: {
  charts: ChartArtifact[];
  palette: Palette;
}) {
  const [index, setIndex] = useState(0);
  const active = charts[Math.min(index, charts.length - 1)] ?? charts[0];
  if (!active) return null;

  if (charts.length === 1) {
    return <ChartCard artifact={active} palette={palette} />;
  }

  function go(delta: number) {
    setIndex((i) => (i + delta + charts.length) % charts.length);
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-icon"
          aria-label="Previous chart"
          onClick={() => go(-1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div
          role="tablist"
          aria-label="Charts in this reply"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            const next =
              e.key === "ArrowLeft"
                ? (index - 1 + charts.length) % charts.length
                : (index + 1) % charts.length;
            setIndex(next);
            const tabs = e.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            );
            tabs[next]?.focus();
          }}
        >
          {charts.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              title={c.title}
              tabIndex={i === index ? 0 : -1}
              className={cn(
                "shrink-0 rounded-[var(--radius)] px-2.5 py-1.5 text-left transition-colors",
                i === index
                  ? "bg-[var(--accent-muted)]"
                  : "hover:bg-[var(--accent-muted)]",
              )}
              onClick={() => setIndex(i)}
            >
              <span className="type-meta block max-w-[10rem] truncate text-[var(--text)]">
                {c.title}
              </span>
              <span className="type-mono block max-w-[10rem] truncate !text-[0.625rem] !text-[var(--text-faint)]">
                {c.queryId ?? chartTypeLabel(c.chartType)}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-icon"
          aria-label="Next chart"
          onClick={() => go(1)}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <p className="type-meta text-[var(--text-faint)]">
        {index + 1} / {charts.length} · ← → switch · type + data below · export
      </p>
      <ChartCard key={active.id} artifact={active} palette={palette} />
    </div>
  );
}

export function AgentArtifacts({ items }: { items: AgentArtifact[] }) {
  const palette = useChartPalette();
  const charts = items.filter((a): a is ChartArtifact => a.kind === "chart");
  const sheets = items.filter(
    (a): a is Extract<AgentArtifact, { kind: "spreadsheet" }> =>
      a.kind === "spreadsheet",
  );
  if (items.length === 0) return null;

  return (
    <div className="mt-3.5 space-y-3">
      {charts.length > 0 ? (
        <section className="space-y-2">
          <p className="type-label flex items-center gap-1.5 text-[var(--text-secondary)]">
            <BarChart3 className="h-3.5 w-3.5" aria-hidden />
            Visuals
          </p>
          <ChartGallery charts={charts} palette={palette} />
        </section>
      ) : null}
      {sheets.map((sheet) => (
        <SpreadsheetArtifact key={sheet.id} artifact={sheet} />
      ))}
    </div>
  );
}
