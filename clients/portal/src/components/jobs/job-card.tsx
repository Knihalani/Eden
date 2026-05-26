"use client";

import { cn } from "@/lib/utils";
import {
  STAGE_LABELS,
  STATUS_COLORS,
  OUTCOME_COLORS,
  type JobListItem,
} from "@/lib/types";
import { ArrowRight, Clock, CheckCircle2, XCircle, AlertCircle, Loader2, Eye, Trash2 } from "lucide-react";
import Link from "next/link";

interface JobCardProps {
  job: JobListItem;
}

const STATUS_ICONS = {
  pending: Clock,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  human_review: AlertCircle,
  cancelled: XCircle,
};

// Border colors for left border pulse
const STATUS_BORDER_COLORS: Record<string, string> = {
  pending: "border-l-yellow-400",
  running: "border-l-blue-500",
  completed: "border-l-green-400",
  failed: "border-l-red-400",
  human_review: "border-l-orange-400",
  cancelled: "border-l-gray-400",
};

// Icon background colors
const STATUS_BG_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  human_review: "bg-orange-100 text-orange-700",
  cancelled: "bg-gray-100 text-gray-700",
};

export function JobCard({ job }: JobCardProps) {
  const statusColor = STATUS_COLORS[job.status] || STATUS_COLORS.pending;
  const outcomeColor = job.outcome_tier ? OUTCOME_COLORS[job.outcome_tier] : null;
  const StatusIcon = STATUS_ICONS[job.status as keyof typeof STATUS_ICONS] || Clock;
  const isRunning = job.status === "running" || job.status === "pending";
  const borderColor = STATUS_BORDER_COLORS[job.status] || STATUS_BORDER_COLORS.pending;
  const bgColor = STATUS_BG_COLORS[job.status] || STATUS_BG_COLORS.pending;

  const createdDate = job.created_at ? new Date(job.created_at) : null;
  const timeAgo = createdDate ? getTimeAgo(createdDate) : null;

  return (
    <div className="group relative">
      {/* Quick Actions - appear on hover */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200 z-10">
        <Link
          href={`/jobs/${job.job_id}`}
          className={cn(
            "p-2 rounded-lg bg-[var(--surface)]/90 backdrop-blur-sm border border-[var(--border)]",
            "text-gray-500 hover:text-[var(--accent)] hover:border-[var(--accent)]",
            "shadow-sm transition-all"
          )}
          title="View job"
        >
          <Eye className="w-4 h-4" />
        </Link>
        <button
          className={cn(
            "p-2 rounded-lg bg-[var(--surface)]/90 backdrop-blur-sm border border-[var(--border)]",
            "text-gray-500 hover:text-red-500 hover:border-red-300",
            "shadow-sm transition-all"
          )}
          title="Delete job"
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <Link
        href={`/jobs/${job.job_id}`}
        className={cn(
          "group block bg-[var(--surface)] shadow-sm rounded-xl p-5",
          "border border-[var(--border)] hover:border-[var(--accent)]",
          "card-hover-lift transition-all duration-200",
          // Left border pulse for running/pending
          "border-l-4",
          borderColor,
          isRunning && "animate-border-pulse"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={cn("p-2.5 rounded-lg shrink-0", bgColor)}>
              <StatusIcon className={cn("w-4 h-4", job.status === "running" && "animate-spin")} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize", statusColor)}>
                  {job.status}
                </span>
                {outcomeColor && (
                  <span className={cn("px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize border", outcomeColor)}>
                    {job.outcome_tier}
                  </span>
                )}
              </div>

              <p className="mt-2 text-sm font-mono font-bold text-gray-900 truncate">
                #{job.job_id.slice(0, 8)}
              </p>

              <p className="mt-1 text-sm text-gray-500 truncate">
                {STAGE_LABELS[job.current_stage] || job.current_stage}
              </p>

              {timeAgo && (
                <p className="mt-1.5 text-xs text-gray-400">
                  {timeAgo}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isRunning && (
              <div className="flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                Live
              </div>
            )}
            <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600 group-hover:translate-x-0.5 transition-all" />
          </div>
        </div>
      </Link>
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}