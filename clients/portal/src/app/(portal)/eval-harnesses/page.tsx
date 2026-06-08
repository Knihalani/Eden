"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { JobCard } from "@/components/jobs/job-card";
import { JobGridSkeleton } from "@/components/jobs/job-filters";
import { Plus, Search, X, ChevronLeft, ChevronRight, SlidersHorizontal, Activity, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

interface JobListItem {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const OUTCOME_OPTIONS = [
  { value: "__all__", label: "Any" },
  { value: "gold", label: "Gold" },
  { value: "silver", label: "Silver" },
  { value: "bronze", label: "Bronze" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
];

function StatCard({ icon: Icon, label, value, sublabel }: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  sublabel?: string;
}) {
  return (
    <div className="bg-[var(--surface)] shadow-sm rounded-xl p-4 border border-[var(--border)] hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-lg bg-[var(--accent-bg)]">
          <Icon className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          <p className="text-sm text-gray-500">{label}</p>
          {sublabel && <p className="text-xs text-gray-400">{sublabel}</p>}
        </div>
      </div>
    </div>
  );
}

function DateRangePicker({ onChange }: { onChange: (range: string) => void }) {
  const options = [
    { value: "all", label: "All time" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "90d", label: "Last 90 days" },
  ];
  const [selected, setSelected] = useState("all");

  const handleSelect = (val: string) => {
    setSelected(val);
    onChange(val);
  };

  return (
    <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => handleSelect(opt.value)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium transition-all",
            selected === opt.value
              ? "bg-[var(--accent)] text-white"
              : "bg-white text-gray-600 hover:bg-gray-50"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function JobsPage() {
  const { flags, loading: flagsLoading } = useFeatureFlags();
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [outcomeTier, setOutcomeTier] = useState("__all__");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [limit] = useState(20);
  const [offset, setOffset] = useState(0);
  const fetchControllerRef = useRef<AbortController | null>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchJobs = useCallback(async () => {
    if (fetchControllerRef.current) {
      fetchControllerRef.current.abort();
    }
    fetchControllerRef.current = new AbortController();

    setLoading(true);
    try {
      const outcomeParam = outcomeTier && outcomeTier !== "__all__" ? `&outcome_tier=${outcomeTier}` : "";
      const qParam = debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : "";
      const res = await fetch(
        `/api/jobs?status=${status}${outcomeParam}${qParam}&sort=created_at:desc&limit=${limit}&offset=${offset}`,
        { signal: fetchControllerRef.current.signal }
      );
      const data = await res.json();
      setJobs(data.jobs || []);
      setTotal(data.total || 0);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.error(err);
      }
    } finally {
      setLoading(false);
    }
  }, [status, outcomeTier, limit, offset, debouncedSearch]);

  useEffect(() => {
    queueMicrotask(() => fetchJobs());
    return () => {
      if (fetchControllerRef.current) {
        fetchControllerRef.current.abort();
      }
    };
  }, [fetchJobs]);

  // Calculate stats from all jobs (fetched with higher limit for stats)
  const [statsJobs, setStatsJobs] = useState<JobListItem[]>([]);
  useEffect(() => {
    fetch("/api/jobs?limit=100&sort=created_at:desc")
      .then(r => r.json())
      .then(data => setStatsJobs(data.jobs || []))
      .catch(console.error);
  }, []);

  const stats = useMemo(() => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentJobs = statsJobs.filter(j => new Date(j.created_at) >= sevenDaysAgo);
    const activeJobs = statsJobs.filter(j => j.status === "running" || j.status === "pending");

    // Success rate: gold + silver among completed jobs in last 7 days
    const completedRecent = recentJobs.filter(j => j.status === "completed");
    const goldSilver = completedRecent.filter(j => j.outcome_tier === "gold" || j.outcome_tier === "silver");
    const successRate = completedRecent.length > 0
      ? Math.round((goldSilver.length / completedRecent.length) * 100)
      : 0;

    return {
      total: statsJobs.length,
      active: activeJobs.length,
      successRate,
      completedCount: completedRecent.length,
    };
  }, [statsJobs]);

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  const pageNumbers = useMemo(() => {
    const pages: (number | "...")[] = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push("...");
      for (
        let i = Math.max(2, currentPage - 1);
        i <= Math.min(totalPages - 1, currentPage + 1);
        i++
      ) {
        pages.push(i);
      }
      if (currentPage < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  }, [currentPage, totalPages]);

  const hasActiveFilters = searchQuery || status || outcomeTier !== "__all__" || dateRange !== "all";

  // When the eval-pipeline feature flag is off, render a friendly disabled
  // state. The sidebar should already hide the "Eval Harnesses" entry, but
  // this guards against direct URL navigation.
  if (!flagsLoading && !flags.enable_eval_pipeline) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <div className="bg-[var(--surface)] shadow-sm rounded-xl p-8 border border-[var(--border)] text-center">
          <h1 className="text-xl font-semibold text-[var(--text-primary)] mb-2">
            Eval Harnesses is disabled
          </h1>
          <p className="text-sm text-[var(--text-muted)] mb-6">
            The multi-stage environment generation pipeline is currently turned off
            on this Eden deployment. Set <code className="font-mono text-xs">ENABLE_EVAL_PIPELINE=true</code> in the
            backend environment to re-enable it.
          </p>
          <Link
            href="/dashboard"
            className="inline-block px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent-hover)]"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">Jobs</h1>
          <p className="text-gray-500 mt-1 text-sm">
            {loading ? "Loading..." : `${total} job${total !== 1 ? "s" : ""} total`}
          </p>
        </div>
        <Link
          href="/eval-harnesses/new"
          className={cn(
            "flex items-center gap-2 bg-[var(--accent)] text-white px-5 py-2.5 rounded-xl",
            "hover:bg-[var(--accent-hover)] transition-all font-semibold text-sm shadow-sm",
            "hover:shadow-md hover:-translate-y-0.5 active:scale-95"
          )}
        >
          <Plus className="w-4 h-4" />
          New Job
        </Link>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Activity} label="Total Jobs" value={stats.total} />
        <StatCard icon={Clock} label="Active Jobs" value={stats.active} sublabel="Running or pending" />
        <StatCard
          icon={CheckCircle2}
          label="Success Rate"
          value={`${stats.successRate}%`}
          sublabel={`Last 7 days (${stats.completedCount} completed)`}
        />
        <StatCard icon={AlertCircle} label="Avg Duration" value="--" sublabel="Coming soon" />
      </div>

      {/* Search & Filters */}
      <div className="mb-6 space-y-4">
        {/* Full-width Search Input */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search jobs by ID or stage..."
            className={cn(
              "w-full pl-12 pr-12 py-3 border border-[var(--border)] rounded-xl",
              "focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent",
              "text-sm placeholder:text-gray-400 bg-[var(--surface)]",
              "shadow-sm transition-shadow"
            )}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors p-1"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Filter Pills Row */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <SlidersHorizontal className="w-4 h-4" />
            <span>Filters:</span>
          </div>

          {/* Status Pills */}
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                setStatus(option.value);
                setOffset(0);
              }}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-semibold transition-all",
                status === option.value
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "bg-[var(--surface)] text-gray-600 border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              )}
            >
              {option.label}
            </button>
          ))}

          {/* Outcome Tier Pills */}
          <div className="h-6 w-px bg-[var(--border)] mx-1" />
          {OUTCOME_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                setOutcomeTier(option.value);
                setOffset(0);
              }}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-semibold transition-all capitalize",
                outcomeTier === option.value
                  ? "bg-yellow-500 text-white shadow-sm"
                  : "bg-[var(--surface)] text-gray-600 border border-[var(--border)] hover:border-yellow-400"
              )}
            >
              {option.label}
            </button>
          ))}

          {/* Date Range Picker */}
          <div className="ml-auto">
            <DateRangePicker onChange={setDateRange} />
          </div>
        </div>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={() => {
              setSearchQuery("");
              setStatus("");
              setOutcomeTier("__all__");
              setDateRange("all");
              setOffset(0);
            }}
            className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] font-medium flex items-center gap-1"
          >
            <X className="w-3 h-3" />
            Clear all filters
          </button>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <JobGridSkeleton />
      ) : jobs.length === 0 ? (
        <div className="bg-[var(--surface)] shadow-sm rounded-2xl p-16 text-center border border-[var(--border)]">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--accent-bg)] mb-6">
            <Search className="w-8 h-8 text-[var(--accent)]" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {hasActiveFilters ? "No jobs match your filters" : "No jobs yet"}
          </h3>
          {hasActiveFilters ? (
            <p className="text-gray-500 text-sm mb-4">
              Try adjusting your search or filters to find what you&apos;re looking for.
            </p>
          ) : (
            <>
              <p className="text-gray-500 text-sm mb-6">
                Get started by creating your first job and watch the magic happen.
              </p>
              <Link
                href="/eval-harnesses/new"
                className={cn(
                  "inline-flex items-center gap-2 bg-[var(--accent)] text-white px-6 py-3 rounded-xl",
                  "hover:bg-[var(--accent-hover)] transition-all font-semibold text-sm",
                  "shadow-sm hover:shadow-md hover:-translate-y-0.5"
                )}
              >
                <Plus className="w-4 h-4" />
                Create your first job
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 stagger-children">
          {jobs.map((job) => (
            <JobCard key={job.job_id} job={job} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-center gap-1 mt-8">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className={cn(
              "p-2 rounded-lg border border-[var(--border)] text-gray-600",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "hover:bg-[var(--surface)] hover:border-gray-300 transition-all"
            )}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-1">
            {pageNumbers.map((page, idx) =>
              page === "..." ? (
                <span key={`ellipsis-${idx}`} className="px-2 text-gray-400">
                  ...
                </span>
              ) : (
                <button
                  key={page}
                  onClick={() => setOffset((page as number - 1) * limit)}
                  className={cn(
                    "w-10 h-10 rounded-lg text-sm font-medium transition-all",
                    currentPage === page
                      ? "bg-[var(--accent)] text-white shadow-sm"
                      : "text-gray-600 hover:bg-gray-100"
                  )}
                >
                  {page}
                </button>
              )
            )}
          </div>

          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
            className={cn(
              "p-2 rounded-lg border border-[var(--border)] text-gray-600",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "hover:bg-[var(--surface)] hover:border-gray-300 transition-all"
            )}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}