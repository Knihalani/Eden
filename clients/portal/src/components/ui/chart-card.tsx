"use client";

import * as React from "react";
import { ResponsiveContainer } from "recharts";
import { Download } from "lucide-react";
import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { downloadCsv, downloadPng } from "@/lib/export";
import { cn } from "@/lib/utils";

export interface ChartCardProps {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  className?: string;
  contentClassName?: string;
  showFallback?: boolean;
  fallback?: React.ReactNode;
  isEmpty?: boolean;
  children: React.ReactElement;
  ariaLabel?: string;
  /** Optional tabular rows for CSV download + accessible table toggle. */
  csvRows?: Array<Record<string, unknown>>;
  csvFilename?: string;
  pngFilename?: string;
  /** Show accessible data table under the chart. */
  showDataTable?: boolean;
}

const DEFAULT_FALLBACK = (
  <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
    No data available for this period
  </div>
);

export function ChartCard({
  title,
  description,
  actions,
  height = 260,
  className,
  contentClassName,
  showFallback = true,
  fallback = DEFAULT_FALLBACK,
  isEmpty = false,
  ariaLabel,
  children,
  csvRows,
  csvFilename,
  pngFilename,
  showDataTable = false,
}: ChartCardProps) {
  const chartRef = React.useRef<HTMLDivElement>(null);
  const [tableOpen, setTableOpen] = React.useState(false);
  const chartAriaLabel = ariaLabel ?? title ?? "Chart";

  const exportActions = (
    <div className="flex items-center gap-1">
      {actions}
      {csvRows && csvRows.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Download chart CSV"
          onClick={() =>
            downloadCsv(csvFilename ?? `${title ?? "chart"}.csv`, csvRows)
          }
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          CSV
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Download chart PNG"
        onClick={() => {
          if (chartRef.current) {
            void downloadPng(pngFilename ?? `${title ?? "chart"}.png`, chartRef.current);
          }
        }}
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        PNG
      </Button>
      {csvRows && csvRows.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={tableOpen || showDataTable}
          onClick={() => setTableOpen((v) => !v)}
        >
          Table
        </Button>
      ) : null}
    </div>
  );

  const keys =
    csvRows && csvRows.length > 0 ? Object.keys(csvRows[0]!) : [];

  return (
    <Section
      title={title}
      description={description}
      actions={exportActions}
      className={className}
      contentClassName={cn("overflow-hidden", contentClassName)}
    >
      <div
        ref={chartRef}
        style={{ width: "100%", height }}
        className="relative"
        role="img"
        aria-label={chartAriaLabel}
      >
        {isEmpty && showFallback ? (
          fallback
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        )}
      </div>
      {(showDataTable || tableOpen) && csvRows && csvRows.length > 0 ? (
        <div className="mt-3 overflow-x-auto border-t border-[var(--border-default)] pt-3">
          <table className="w-full text-xs text-left">
            <caption className="sr-only">{chartAriaLabel} data</caption>
            <thead>
              <tr>
                {keys.map((k) => (
                  <th key={k} className="px-2 py-1 font-medium text-[var(--text-muted)]">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {csvRows.map((row, i) => (
                <tr key={i} className="border-t border-[var(--border-subtle)]">
                  {keys.map((k) => (
                    <td key={k} className="px-2 py-1 text-[var(--text-secondary)]">
                      {String(row[k] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
