"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Section } from "@/components/layout/section";

const TOOLTIP_STYLE = {
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "8px",
  fontSize: "12px",
  color: "var(--text-primary)",
  padding: "8px 12px",
};

const AXIS_TICK = { fill: "var(--text-muted)", fontSize: 11 };

export interface ChartCardProps {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  className?: string;
  children: React.ReactNode;
}

export function ChartCard({
  title,
  description,
  actions,
  height = 220,
  className,
  children,
}: ChartCardProps) {
  return (
    <Section
      title={title}
      description={description}
      actions={actions}
      className={className}
      contentClassName="overflow-hidden"
    >
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </Section>
  );
}

export const ChartGrid = CartesianGrid;
export const ChartTooltip = Tooltip;
export const ChartXAxis = XAxis;
export const ChartYAxis = YAxis;
export const ChartLegend = Legend;
export const ChartLine = Line;
export const ChartArea = Area;
export const ChartBar = Bar;
export const ChartPie = Pie;
export const ChartCell = Cell;
export const chartTooltipStyle = TOOLTIP_STYLE;
export const chartAxisTick = AXIS_TICK;
export {
  LineChart,
  AreaChart,
  BarChart,
  PieChart,
};
