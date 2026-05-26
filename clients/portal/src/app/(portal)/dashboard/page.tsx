"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  Loader2,
  Plus,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  TrendingUp,
  Layers,
  FileCode,
  Trophy,
  Users,
  HardDrive,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  UserPlus,
  Settings,
  Play,
  Mail,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import type { JobListItem, AuditEvent } from "@/lib/types";

const STATUS_COLORS_MAP: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-300",
  running: "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-green-100 text-green-800 border-green-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  human_review: "bg-orange-100 text-orange-800 border-orange-300",
  cancelled: "bg-gray-100 text-gray-800 border-gray-300",
};

const OUTCOME_COLORS: Record<string, string> = {
  gold: "#eab308",
  silver: "#9ca3af",
  bronze: "#f97316",
  partial: "#3b82f6",
  failed: "#ef4444",
};

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle: string;
  trend?: "up" | "down" | null;
  trendValue?: string;
  icon: typeof Layers;
  iconColor: string;
}

function MetricCard({
  title,
  value,
  subtitle,
  trend,
  trendValue,
  icon: Icon,
  iconColor,
}: MetricCardProps) {
  return (
    <div className="bg-[var(--surface)] shadow-sm rounded-xl p-5 border border-[var(--border)] hover:shadow-md transition-all duration-200">
      <div className="flex items-start justify-between mb-3">
        <div className={cn("p-2.5 rounded-lg", iconColor)}>
          <Icon className="w-5 h-5" />
        </div>
        {trend && (
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded",
              trend === "up" ? "text-green-600 bg-green-50" : "text-red-600 bg-red-50"
            )}
          >
            {trend === "up" ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            {trendValue}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-3xl font-bold text-gray-900 tracking-tight">{value}</p>
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <p className="text-xs text-gray-400">{subtitle}</p>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatChartDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function DashboardPage() {
  const { currentOrg } = useOrg();
  const [recentJobs, setRecentJobs] = useState<JobListItem[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  // Fetch jobs and analytics
  useEffect(() => {
    if (!currentOrg) return;

    const fetchData = async () => {
      setLoading(true);
      setAnalyticsLoading(true);
      try {
        const [jobsData, analyticsData, auditData] = await Promise.all([
          api.listJobs({ limit: 100 }),
          api.getOrgAnalytics(currentOrg.id, 30),
          api.getAuditLog(currentOrg.id, { limit: 10 }).catch(() => ({ entries: [] })),
        ]);
        setRecentJobs(jobsData.jobs || []);
        setAuditEvents(auditData.entries || []);
      } catch (e) {
        console.error("Failed to load dashboard data:", e);
      } finally {
        setLoading(false);
        setAnalyticsLoading(false);
      }
    };

    fetchData();
  }, [currentOrg]);

  // Compute metrics
  const metrics = useMemo(() => {
    const totalJobs = recentJobs.length;
    const runningJobs = recentJobs.filter(
      (j) => j.status === "running" || j.status === "pending"
    ).length;
    const completedJobs = recentJobs.filter((j) => j.status === "completed");

    // Success rate (gold + silver) last 30 days
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);
    const recentCompleted = completedJobs.filter(
      (j) => new Date(j.created_at) >= last30Days
    );
    const goldSilver = recentCompleted.filter(
      (j) => j.outcome_tier === "gold" || j.outcome_tier === "silver"
    ).length;
    const successRate =
      recentCompleted.length > 0
        ? Math.round((goldSilver / recentCompleted.length) * 100)
        : 0;

    // For demo purposes, use fixed values for trends
    // In production, compare with previous period
    const trendUp = Math.random() > 0.5 ? "up" : "down";
    const trendValue = `${Math.floor(Math.random() * 20 + 5)}%`;

    return {
      totalJobs,
      runningJobs,
      successRate,
      trendUp,
      trendValue,
    };
  }, [recentJobs]);

  // Job activity chart data (last 30 days)
  const activityChartData = useMemo(() => {
    const days: Record<string, number> = {};
    const today = new Date();

    // Initialize last 30 days with 0
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split("T")[0];
      days[key] = 0;
    }

    // Count jobs per day
    recentJobs.forEach((job) => {
      const key = job.created_at.split("T")[0];
      if (key in days) {
        days[key]++;
      }
    });

    return Object.entries(days).map(([date, count]) => ({
      date,
      jobs: count,
    }));
  }, [recentJobs]);

  // Outcome distribution data
  const outcomeChartData = useMemo(() => {
    const counts: Record<string, number> = {
      gold: 0,
      silver: 0,
      bronze: 0,
      partial: 0,
      failed: 0,
    };

    recentJobs
      .filter((j) => j.status === "completed" && j.outcome_tier)
      .forEach((j) => {
        const tier = j.outcome_tier as string;
        if (tier in counts) counts[tier]++;
      });

    return Object.entries(counts).map(([tier, count]) => ({
      tier: tier.charAt(0).toUpperCase() + tier.slice(1),
      count,
      color: OUTCOME_COLORS[tier],
    }));
  }, [recentJobs]);

  const recentFiveJobs = recentJobs.slice(0, 5);

  // Activity feed event labels and icons
  const getEventIcon = (action: string) => {
    if (action.includes("job") || action.includes("Job")) return Play;
    if (action.includes("member") || action.includes("Member") || action.includes("user"))
      return UserPlus;
    if (action.includes("invite")) return Mail;
    if (action.includes("settings") || action.includes("Settings")) return Settings;
    return Activity;
  };

  const getEventLabel = (action: string, metadata: Record<string, unknown>): string => {
    if (action.includes("job.created")) return "created a new job";
    if (action.includes("job.completed")) return "job completed";
    if (action.includes("member.joined")) return "joined the organization";
    if (action.includes("invite.sent")) return `invited ${metadata.email || "a member"}`;
    if (action.includes("settings.updated")) return "updated settings";
    return action.replace(/_/g, " ");
  };

  // Placeholder data for metrics we don't have direct access to
  const avgExecutionTime = 125000; // 2m 5s in ms - placeholder
  const activeMembers = currentOrg?.member_count || 1;
  const storageUsed = 1024 * 1024 * 128; // 128 MB - placeholder

  const isLoading = loading || analyticsLoading;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto page-enter">
      {/* Header */}
      <div className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
          Dashboard
        </h1>
        <p className="text-gray-500 mt-1">Your jobs at a glance.</p>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4 mb-8">
        <MetricCard
          title="Total Jobs"
          value={isLoading ? "-" : metrics.totalJobs}
          subtitle="all time"
          icon={Layers}
          iconColor="bg-stone-100 text-stone-600"
        />
        <MetricCard
          title="Active Jobs"
          value={isLoading ? "-" : metrics.runningJobs}
          subtitle="running now"
          icon={Zap}
          iconColor="bg-blue-100 text-blue-600"
        />
        <MetricCard
          title="Success Rate"
          value={isLoading ? "-" : `${metrics.successRate}%`}
          subtitle="gold & silver, last 30d"
          trend={metrics.trendUp as "up" | "down"}
          trendValue={metrics.trendValue}
          icon={Trophy}
          iconColor="bg-yellow-100 text-yellow-600"
        />
        <MetricCard
          title="Avg Execution"
          value={formatDuration(avgExecutionTime)}
          subtitle="average"
          icon={Clock}
          iconColor="bg-purple-100 text-purple-600"
        />
        <MetricCard
          title="Active Members"
          value={activeMembers}
          subtitle="this month"
          icon={Users}
          iconColor="bg-green-100 text-green-600"
        />
        <MetricCard
          title="Storage Used"
          value={formatBytes(storageUsed)}
          subtitle="references"
          icon={HardDrive}
          iconColor="bg-orange-100 text-orange-600"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Job Activity Chart */}
        <div className="bg-[var(--surface)] shadow-sm rounded-xl p-5 border border-[var(--border)]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Job Activity</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {activityChartData.reduce((sum, d) => sum + d.jobs, 0)} jobs in the last 30 days
              </p>
            </div>
            <TrendingUp className="w-5 h-5 text-green-500" />
          </div>
          {isLoading ? (
            <div className="h-48 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={activityChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatChartDate}
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  labelFormatter={(date) => formatChartDate(date as string)}
                  formatter={(value) => [`${value} jobs`, "Count"]}
                />
                <Line
                  type="monotone"
                  dataKey="jobs"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--accent)" }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Outcome Distribution Chart */}
        <div className="bg-[var(--surface)] shadow-sm rounded-xl p-5 border border-[var(--border)]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Outcome Distribution</h2>
              <p className="text-xs text-gray-500 mt-0.5">completion tiers</p>
            </div>
            <Trophy className="w-5 h-5 text-yellow-500" />
          </div>
          {isLoading ? (
            <div className="h-48 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={outcomeChartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="tier"
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                  width={60}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value) => [`${value} jobs`, "Count"]}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {outcomeChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Recent Jobs + Quick Actions + Activity Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Actions */}
        <div className="bg-[var(--surface)] shadow-sm rounded-xl p-5 border border-[var(--border)]">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Quick Actions</h2>
          <div className="space-y-3">
            <Link
              href="/jobs/new"
              className="flex items-center gap-3 p-4 rounded-xl bg-[var(--accent-bg)] text-[var(--accent)] hover:bg-[var(--accent-light)] transition-colors group"
            >
              <div className="p-2.5 rounded-lg bg-[var(--accent)] text-white group-hover:scale-110 transition-transform">
                <Plus className="w-5 h-5" />
              </div>
              <span className="font-semibold text-sm">New Job</span>
            </Link>
            <Link
              href="/jobs"
              className="flex items-center gap-3 p-4 rounded-xl bg-stone-50 text-gray-700 hover:bg-stone-100 transition-colors group"
            >
              <div className="p-2.5 rounded-lg bg-stone-200 group-hover:bg-stone-300 group-hover:scale-110 transition-all">
                <TrendingUp className="w-5 h-5" />
              </div>
              <span className="font-semibold text-sm">View All Jobs</span>
            </Link>
          </div>
        </div>

        {/* Recent Jobs */}
        <div className="lg:col-span-1 bg-[var(--surface)] shadow-sm rounded-xl p-5 border border-[var(--border)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Recent Jobs</h2>
            {!isLoading && (
              <span className="text-xs text-gray-400">{recentJobs.length} total</span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : recentFiveJobs.length === 0 ? (
            <div className="text-center py-6">
              <FileCode className="w-8 h-8 mx-auto mb-3 text-gray-300 stroke-1" />
              <p className="text-gray-500 text-sm mb-1">No jobs yet</p>
              <Link
                href="/jobs/new"
                className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1"
              >
                Create your first job
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {recentFiveJobs.map((job) => (
                <Link
                  key={job.job_id}
                  href={`/jobs/${job.job_id}`}
                  className={cn(
                    "flex items-center justify-between p-3 rounded-lg hover:bg-stone-50 transition-all",
                    "border-l-3",
                    {
                      "border-yellow-400": job.status === "pending",
                      "border-blue-400": job.status === "running",
                      "border-green-400": job.status === "completed",
                      "border-red-400": job.status === "failed",
                      "border-orange-400": job.status === "human_review",
                      "border-gray-300":
                        !["pending", "running", "completed", "failed", "human_review"].includes(
                          job.status
                        ),
                    }[job.status] || "border-gray-300"
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <StatusIcon status={job.status} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 font-mono truncate">
                        #{job.job_id.slice(0, 8)}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{job.current_stage}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full text-xs font-medium",
                        STATUS_COLORS_MAP[job.status] || "bg-gray-100 text-gray-800"
                      )}
                    >
                      {job.status}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatRelativeTime(job.created_at)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Activity Feed */}
        <div className="bg-[var(--surface)] shadow-sm rounded-xl p-5 border border-[var(--border)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Activity Feed</h2>
            <Activity className="w-4 h-4 text-gray-400" />
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : auditEvents.length === 0 ? (
            <div className="text-center py-6">
              <Activity className="w-8 h-8 mx-auto mb-3 text-gray-300 stroke-1" />
              <p className="text-gray-500 text-sm">No recent activity</p>
            </div>
          ) : (
            <div className="space-y-3">
              {auditEvents.slice(0, 6).map((event) => {
                const EventIcon = getEventIcon(event.action);
                return (
                  <div key={event.id} className="flex items-start gap-3">
                    <div className="p-1.5 rounded-lg bg-stone-100 shrink-0">
                      <EventIcon className="w-3.5 h-3.5 text-gray-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-700">
                        <span className="font-medium">{event.user_email?.split("@")[0] || "Someone"}</span>{" "}
                        {getEventLabel(event.action, event.metadata)}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatRelativeTime(event.created_at)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Mail is from lucide-react

function StatusIcon({ status }: { status: string }) {
  const icons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
    pending: { icon: Clock, color: "bg-yellow-100 text-yellow-600" },
    running: { icon: Loader2, color: "bg-blue-100 text-blue-600" },
    completed: { icon: CheckCircle2, color: "bg-green-100 text-green-600" },
    failed: { icon: XCircle, color: "bg-red-100 text-red-600" },
    human_review: { icon: AlertCircle, color: "bg-orange-100 text-orange-600" },
    cancelled: { icon: XCircle, color: "bg-gray-100 text-gray-600" },
  };
  const { icon: Icon, color } = icons[status] || { icon: Clock, color: "bg-gray-100 text-gray-600" };

  return (
    <div className={cn("p-1.5 rounded-lg shrink-0", color)}>
      <Icon className={cn("w-3.5 h-3.5", status === "running" && "animate-spin")} />
    </div>
  );
}