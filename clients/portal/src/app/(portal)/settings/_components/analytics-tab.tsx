"use client";

import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import type { OrgAnalytics } from "@/lib/types";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from "recharts";
import { RefreshCw, TrendingUp, Users, Database, Code, BarChart2 } from "lucide-react";
// ui-audit 2026-07-06 H1: centralized SSR-safe chart palette.
// The hex SSR fallback + var() resolver now live in
// @/lib/chart-colors so every chart in the portal uses the
// same single source of truth.
import { getStorageColorsResolved } from "@/lib/chart-colors";
import { errorFromCaught } from "@/lib/safe-error-message";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

const STORAGE_COLORS = getStorageColorsResolved();

export function AnalyticsTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const canViewAnalytics = hasPermission("audit:view");
  const orgId = currentOrg?.id ?? null;
  const analyticsQuery = useOrgQuery(
    queryKeys.orgAnalytics.detail(orgId),
    orgId,
    () => api.getOrgAnalytics(orgId!),
    { enabled: canViewAnalytics },
  );
  const analytics = analyticsQuery.data ?? null;
  const loading = analyticsQuery.isLoading;
  const error = analyticsQuery.error
    ? errorFromCaught(analyticsQuery.error, "Failed to load analytics")
    : null;

  if (!canViewAnalytics) {
    return (
      <div className="p-6 bg-[var(--error-dim)] rounded-lg border border-[var(--error)]">
        <p className="text-sm text-[var(--error)]">
          You do not have permission to view organization analytics. Contact your organization admin.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load analytics"
        message={error}
        action={
          <Button
            type="button"
            variant="outline"
            size="default"
            onClick={() => void analyticsQuery.refetch()}
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        }
      />
    );
  }

  if (!analytics) {
    return (
      <EmptyState
        icon={BarChart2}
        title="No analytics data yet"
        description="Usage charts appear once the workspace has members, references, or storage activity."
      />
    );
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const storageData = [
    { name: "Used Storage", value: analytics.storage_bytes_used },
    { name: "Available", value: Math.max(0, 100 * 1024 * 1024 - analytics.storage_bytes_used) },
  ];

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--accent-faint)] rounded-lg">
              <TrendingUp className="w-5 h-5 text-[var(--accent)]" />
            </div>
            <div>
              <p className="text-sm text-[var(--text-muted)]">Active Members</p>
              <p className="text-2xl font-semibold">{analytics.active_members_count}</p>
            </div>
          </div>
        </div>

        <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--terminal-faint)] rounded-lg">
              <Code className="w-5 h-5 text-[var(--terminal)]" />
            </div>
            <div>
              <p className="text-sm text-[var(--text-muted)]">Total References</p>
              <p className="text-2xl font-semibold">{analytics.total_references}</p>
            </div>
          </div>
        </div>

        <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--accent-faint)] rounded-lg">
              <Database className="w-5 h-5 text-[var(--accent)]" />
            </div>
            <div>
              <p className="text-sm text-[var(--text-muted)]">Storage Used</p>
              <p className="text-2xl font-semibold">{formatBytes(analytics.storage_bytes_used)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Job Counts Chart */}
      <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
        <h3 className="text-lg font-semibold mb-4">Job Activity</h3>
        {analytics.job_counts_by_day.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.job_counts_by_day}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  }}
                />
                <YAxis allowDecimals={false} />
                <Tooltip
                  labelFormatter={(value) => new Date(value).toLocaleDateString()}
                  formatter={(value) => [`${value} jobs`, "Count"]}
                />
                <Bar dataKey="count" fill="var(--chart-primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)] py-8 text-center">No job data available for this period.</p>
        )}
      </div>

      {/* Reference Uploads Chart */}
      <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
        <h3 className="text-lg font-semibold mb-4">Reference Uploads</h3>
        {analytics.reference_uploads_by_day.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.reference_uploads_by_day}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  }}
                />
                <YAxis allowDecimals={false} />
                <Tooltip
                  labelFormatter={(value) => new Date(value).toLocaleDateString()}
                  formatter={(value) => [`${value} uploads`, "Count"]}
                />
                <Line type="monotone" dataKey="count" stroke="var(--chart-success)" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)] py-8 text-center">No reference upload data available.</p>
        )}
      </div>

      {/* Storage Pie Chart */}
      <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
        <h3 className="text-lg font-semibold mb-4">Storage Distribution</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={storageData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                paddingAngle={5}
                dataKey="value"
              >
                {storageData.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={STORAGE_COLORS[index % STORAGE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => formatBytes(value as number)} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-center gap-4 mt-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[var(--accent)]" />
            <span className="text-sm text-[var(--text-secondary)]">Used ({formatBytes(analytics.storage_bytes_used)})</span>
          </div>
        </div>
      </div>

      {/* Member Activity */}
      <div className="bg-[var(--bg-primary)] p-4 rounded-lg border border-[var(--border-default)]">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Users className="w-5 h-5" />
          Member Activity
        </h3>
        <div className="space-y-3">
          {analytics.member_activity.map((member) => (
            <div
              key={member.user_id}
              className="flex items-center justify-between py-2 border-b border-[var(--border-subtle)] last:border-0"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-[var(--bg-tertiary)] rounded-full flex items-center justify-center text-sm font-medium">
                  {member.name?.charAt(0).toUpperCase() || member.email.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium">{member.name || member.email}</p>
                  <p className="text-xs text-[var(--text-muted)]">{member.role}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-[var(--text-muted)]">
                  Last active: {member.last_active_at
                    ? new Date(member.last_active_at).toLocaleDateString()
                    : "Never"}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Joined: {member.joined_at ? new Date(member.joined_at).toLocaleDateString() : "Unknown"}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}