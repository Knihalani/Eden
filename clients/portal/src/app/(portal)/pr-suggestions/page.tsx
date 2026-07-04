"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitPullRequestArrow,
  Plus,
  RefreshCw,
  Search,
  Filter,
  X,
  AlertCircle,
  Clock,
  
  FileCode,
  Sparkles,
  TrendingUp,
  CheckCheck,
  History,
  ChevronDown,
  RotateCcw,
  CheckSquare,
  Square,
  Zap } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { prSuggestionApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PRStatusBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import type {
  PRSuggestion,
  PRSuggestionStatus,
  PRSuggestionTrigger } from "@/lib/types";

// ── Trigger / status mapping ────────────────────────────────────

const TRIGGER_LABELS: Record<PRSuggestionTrigger, string> = {
  rca_cluster: "RCA cluster",
  drift_alert: "Drift alert",
  retrieval_gap: "Retrieval gap",
  judge_regression: "Judge regression" };

const TRIGGER_COLORS: Record<PRSuggestionTrigger, string> = {
  rca_cluster: "bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/20",
  drift_alert: "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/20",
  retrieval_gap: "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20",
  judge_regression: "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20" };

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const diff = Math.floor((Date.now() - d) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return iso;
  }
}

// ── Skeleton card (used while loading the inbox) ───────────────

function SkeletonCard() {
  return (
    <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
      <div className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    </Card>
  );
}

// ── Suggestion card ────────────────────────────────────────────

function SuggestionCard({
  suggestion,
  selected,
  onSelectToggle,
  onClick }: {
  suggestion: PRSuggestion;
  selected: boolean;
  onSelectToggle: () => void;
  onClick: () => void;
}) {
  return (
    <div className="relative">
      {/* Selection checkbox (top-left corner) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSelectToggle();
        }}
        className={cn(
          "absolute top-3 left-3 z-10 p-1 rounded",
          selected
            ? "text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text-muted)]",
        )}
        aria-label={selected ? "Deselect" : "Select"}
      >
        {selected ? (
          <CheckSquare className="h-4 w-4" />
        ) : (
          <Square className="h-4 w-4" />
        )}
      </button>
      <Card
        onClick={onClick}
        className={cn(
          "cursor-pointer border-[var(--border-default)] bg-[var(--bg-base)] hover:border-[var(--border-default)] transition-colors pl-8",
          selected && "border-[var(--accent)]/40 bg-[var(--accent)]/5",
        )}
      >
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Badge
              variant="outline"
              className={cn("text-xs", TRIGGER_COLORS[suggestion.trigger])}
            >
              <Sparkles className="h-3 w-3 mr-1" />
              {TRIGGER_LABELS[suggestion.trigger]}
            </Badge>
            <PRStatusBadge status={suggestion.status} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)] line-clamp-2">
              {suggestion.pr_title || "[Eden Agent] Untitled suggestion"}
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">
              {suggestion.trigger_summary}
            </p>
          </div>

          {suggestion.files.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {suggestion.files.slice(0, 3).map((f) => (
                <Badge
                  key={f.path}
                  variant="outline"
                  className="text-[10px] bg-[var(--bg-base)] text-[var(--text-muted)] border-[var(--border-default)]"
                >
                  <FileCode className="h-2.5 w-2.5 mr-0.5" />
                  {f.path.split("/").pop()}
                </Badge>
              ))}
              {suggestion.files.length > 3 && (
                <Badge
                  variant="outline"
                  className="text-[10px] bg-[var(--bg-base)] text-[var(--text-muted)] border-[var(--border-default)]"
                >
                  +{suggestion.files.length - 3} more
                </Badge>
              )}
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {Math.round(suggestion.confidence * 100)}% conf
              </span>
              {suggestion.opened_pr_number !== null && (
                <span className="flex items-center gap-1 text-[var(--accent)]">
                  <GitPullRequestArrow className="h-3 w-3" />
                  #{suggestion.opened_pr_number}
                </span>
              )}
            </div>
            <span>{relativeTime(suggestion.created_at)}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ── Create dialog ──────────────────────────────────────────────

function CreateSuggestionForm({
  onCreated,
  onCancel,
  recentFiles: parentRecentFiles = [] }: {
  onCreated: (id: string) => void;
  onCancel: () => void;
  recentFiles?: string[];
}) {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [trigger, setTrigger] = useState<PRSuggestionTrigger>("rca_cluster");
  const [triggerId, setTriggerId] = useState("clu_demo_001");
  const [summary, setSummary] = useState("");
  const [files, setFiles] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const fileInputRef = useRef<HTMLTextAreaElement>(null);

  // Sample triggers per kind — click to populate the form.
  const samples: Record<PRSuggestionTrigger, { id: string; summary: string; files: string[] }> = {
    rca_cluster: {
      id: "clu_demo_001",
      summary: "Hallucination score dropped 4% in customer_service_v1 over the last 7d",
      files: ["src/eden/services/customer_service.py"] },
    drift_alert: {
      id: "alert_drift_demo",
      summary: "Drift detected: judge-score distribution shifted (PSI 0.28)",
      files: ["src/eden/predictive/drift.py"] },
    retrieval_gap: {
      id: "gap_demo_001",
      summary: "Top-5 retrieval utilization is 0.42 (below the 0.7 target)",
      files: ["src/eden/kb/retrieval_intel/reorderer.py"] },
    judge_regression: {
      id: "judge_demo_001",
      summary: "Correctness judge dropped 0.06 over 24h",
      files: ["src/eden/evaluation/eval_intel/judges.py"] } };

  function applySample() {
    const s = samples[trigger];
    setTriggerId(s.id);
    setSummary(s.summary);
    setFiles(s.files.join("\n"));
  }

  // Recent files autocomplete — pass recent file paths from the parent
  // (the suggestion list). Falls back to an empty list while loading.
  const recentFiles = parentRecentFiles;

  const fileList = files
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  async function handleSubmit() {
    if (!currentOrg) return;
    if (!triggerId.trim()) {
      setError("trigger_id is required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload: {
        trigger: string;
        trigger_id: string;
        trigger_payload: Record<string, unknown>;
      } = {
        trigger,
        trigger_id: triggerId.trim(),
        trigger_payload: {} };
      if (summary.trim()) {
        payload.trigger_payload.description = summary.trim();
      }
      if (fileList.length > 0) {
        payload.trigger_payload.affected_files = fileList;
      }
      const data = await prSuggestionApi.create(currentOrg.id, payload);
      onCreated(data.data.suggestion_id);
      toast.success("Suggestion generated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      toast.error(err instanceof Error ? err.message : "Failed to create suggestion");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <Card className="border-[var(--border-default)] bg-[var(--bg-base)] mb-4">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[var(--accent)]" />
              New PR suggestion
            </h3>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={applySample}
                type="button"
              >
                <Zap className="h-3 w-3 mr-1" />
                Use sample
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel} type="button" aria-label="Close new suggestion form">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--text-muted)] mb-1 block">Trigger</label>
              <select
                value={trigger}
                onChange={(e) =>
                  setTrigger(e.target.value as PRSuggestionTrigger)
                }
                aria-label="Suggestion trigger type"
                className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)]"
              >
                <option value="rca_cluster">RCA cluster</option>
                <option value="drift_alert">Drift alert</option>
                <option value="retrieval_gap">Retrieval gap</option>
                <option value="judge_regression">Judge regression</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] mb-1 block">
                Trigger ID
              </label>
              <input
                value={triggerId}
                onChange={(e) => setTriggerId(e.target.value)}
                placeholder="e.g. clu_abc123"
                aria-label="Trigger identifier"
                className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)] font-mono"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Summary</label>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What happened? (1 sentence)"
              aria-label="Suggestion summary"
              className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-[var(--text-muted)]">
                Affected files (one per line)
              </label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSuggestions((v) => !v)}
                  aria-label="Show recent file suggestions"
                  aria-expanded={showSuggestions}
                  className="text-xs text-[var(--accent)] hover:text-[var(--accent)] flex items-center gap-1"
                >
                  Recent <ChevronDown className="h-3 w-3" />
                </button>
                <AnimatePresence>
                  {showSuggestions && recentFiles.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="absolute right-0 top-6 z-10 w-64 bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg shadow-xl max-h-40 overflow-auto"
                    >
                      {recentFiles.map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => {
                            setFiles((prev) =>
                              prev ? `${prev}\n${f}` : f,
                            );
                            setShowSuggestions(false);
                            fileInputRef.current?.focus();
                          }}
                          className="w-full text-left px-3 py-1.5 text-xs font-mono text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
                        >
                          {f}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
            <textarea
              ref={fileInputRef}
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              onFocus={() => setShowSuggestions(false)}
              placeholder={"src/eden/foo.py\nsrc/eden/bar.py"}
              aria-label="Affected files (one per line)"
              className="w-full h-24 bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)] font-mono"
            />
          </div>

          {error && (
            <div className="text-xs text-[var(--error)] flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={busy} type="button">
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={busy} type="button">
              {busy ? (
                <RefreshCw className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              Generate
            </Button>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

// ── Bulk-action bar ─────────────────────────────────────────────

function BulkActionBar({
  selected,
  onRegenerate,
  onClear,
  busy }: {
  selected: string[];
  onRegenerate: () => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl shadow-2xl px-4 py-2.5 flex items-center gap-3"
    >
      <span className="text-sm text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text-primary)]">{selected.length}</span>{" "}
        selected
      </span>
      <div className="h-5 w-px bg-[var(--border-default)]" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onRegenerate}
        disabled={busy}
      >
        {busy ? (
          <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
        ) : (
          <RotateCcw className="h-4 w-4 mr-1" />
        )}
        Regenerate
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </motion.div>
  );
}

// ── Main page ──────────────────────────────────────────────────

export default function PRSuggestionsPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [suggestions, setSuggestions] = useState<PRSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<PRSuggestionStatus | "all">(
    "all",
  );
  const [triggerFilter, setTriggerFilter] = useState<
    PRSuggestionTrigger | "all"
  >("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const loadSuggestions = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (triggerFilter !== "all") params.set("trigger", triggerFilter);
      if (search) params.set("search", search);
      params.set("limit", "50");
      const data = await prSuggestionApi.list(
        currentOrg.id,
        params.toString(),
      );
      setSuggestions(data.data.suggestions);
      // Drop any selected ids that are no longer in the list.
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const validIds = new Set(data.data.suggestions.map((s) => s.id));
        const next = new Set<string>();
        prev.forEach((id) => {
          if (validIds.has(id)) next.add(id);
        });
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, statusFilter, triggerFilter, search]);

  useEffect(() => {
     
    loadSuggestions();
  }, [loadSuggestions]);

  // Recent files autocomplete — collect file paths from the
  // most recent suggestions in the inbox. Dedupe + cap at 12
  // entries so the dropdown stays short.
  const recentFiles = useMemo(() => {
    const collected: string[] = [];
    for (const s of suggestions.slice(0, 20)) {
      for (const f of s.files ?? []) {
        if (!collected.includes(f.path)) collected.push(f.path);
        if (collected.length >= 12) break;
      }
      if (collected.length >= 12) break;
    }
    return collected;
  }, [suggestions]);

  // Stats
  const stats = {
    pending: suggestions.filter((s) => s.status === "pending").length,
    openedToday: suggestions.filter(
      (s) =>
        s.status === "opened" &&
        new Date(s.created_at).toDateString() === new Date().toDateString(),
    ).length,
    merged30d: suggestions.filter(
      (s) =>
        s.status === "merged" &&
         
        Date.now() - new Date(s.created_at).getTime() < 30 * 86400 * 1000,
    ).length,
    totalConfidence:
      suggestions.length > 0
        ? Math.round(
            (suggestions.reduce((acc, s) => acc + s.confidence, 0) /
              suggestions.length) *
              100,
          )
        : 0 };

  // All-visible selected? Used for the "select all" toggle.
  const visibleIds = useMemo(
    () => new Set(suggestions.map((s) => s.id)),
    [suggestions],
  );
  const allSelected =
    visibleIds.size > 0 &&
    Array.from(visibleIds).every((id) => selected.has(id));

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleIds));
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkRegenerate() {
    if (!currentOrg || selected.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const data = await prSuggestionApi.bulkRegenerate(currentOrg.id, ids);
      const { regenerated, skipped } = data.data;
      toast.success(
        `Regenerated ${regenerated.length} of ${ids.length} suggestions${
          skipped.length > 0 ? ` (${skipped.length} skipped)` : ""
        }`,
      );
      setSelected(new Set());
      await loadSuggestions();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Bulk regenerate failed",
      );
    } finally {
      setBulkBusy(false);
    }
  }

  if (!currentOrg) {
    return (
      <div className="p-6">
        <EmptyState
          icon={History}
          title="No organization"
          description="Select an organization to view PR suggestions."
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="PR Suggestions"
        subtitle="Agent-proposed code changes based on observability signals"
        icon={GitPullRequestArrow}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={loadSuggestions}
              disabled={loading}
              size="sm"
            >
              <RefreshCw
                className={cn("h-4 w-4 mr-1", loading && "animate-spin")}
              />
              Refresh
            </Button>
            <Button onClick={() => setShowCreate((v) => !v)} size="sm">
              <Plus className="h-4 w-4 mr-1" />
              {showCreate ? "Cancel" : "New suggestion"}
            </Button>
          </div>
        }
      />

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Pending review" value={stats.pending} icon={Clock} />
        <StatCard
          title="Opened today"
          value={stats.openedToday}
          icon={GitPullRequestArrow}
        />
        <StatCard
          title="Merged (30d)"
          value={stats.merged30d}
          icon={CheckCheck}
        />
        <StatCard
          title="Avg confidence"
          value={`${stats.totalConfidence}%`}
          icon={TrendingUp}
        />
      </div>

      {/* Create form (collapsible) */}
      <AnimatePresence>
        {showCreate && (
          <CreateSuggestionForm
            onCreated={(id) => {
              setShowCreate(false);
              router.push(`/pr-suggestions/${id}`);
            }}
            onCancel={() => setShowCreate(false)}
            recentFiles={recentFiles}
          />
        )}
      </AnimatePresence>

      {/* Filter bar */}
      <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
        <div className="p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="h-4 w-4 text-[var(--text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or summary…"
              aria-label="Search PR suggestions"
              className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
          </div>
          {suggestions.length > 0 && (
            <button
              onClick={toggleSelectAll}
              aria-label={allSelected ? "Deselect all suggestions" : "Select all visible suggestions"}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1.5"
            >
              {allSelected ? (
                <CheckSquare className="h-4 w-4 text-[var(--accent)]" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              Select all
            </button>
          )}
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-[var(--text-muted)]" />
            <select
              value={triggerFilter}
              onChange={(e) =>
                setTriggerFilter(
                  e.target.value as PRSuggestionTrigger | "all",
                )
              }
              aria-label="Filter by trigger type"
              className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-1.5 text-sm text-[var(--text-primary)]"
            >
              <option value="all">All triggers</option>
              <option value="rca_cluster">RCA cluster</option>
              <option value="drift_alert">Drift alert</option>
              <option value="retrieval_gap">Retrieval gap</option>
              <option value="judge_regression">Judge regression</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(
                  e.target.value as PRSuggestionStatus | "all",
                )
              }
              aria-label="Filter by status"
              className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-1.5 text-sm text-[var(--text-primary)]"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="opened">Opened</option>
              <option value="merged">Merged</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Error */}
      {error && (
        <Card className="border-[var(--error)]/20 bg-[var(--error)]/5">
          <div
            role="alert"
            className="p-3 text-sm text-[var(--error)] flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </span>
            <button
              onClick={loadSuggestions}
              disabled={loading}
              className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        </Card>
      )}

      {/* Suggestion list — skeleton on first load */}
      {loading && suggestions.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="grid grid-cols-1 md:grid-cols-2 gap-3"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : suggestions.length === 0 ? (
        <EmptyState
          title="No PR suggestions yet"
          description="The agent watches observability signals (RCA clusters, drift alerts, retrieval gaps, judge regressions) and proposes a code change here when it spots something actionable."
          icon={History}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              selected={selected.has(s.id)}
              onSelectToggle={() => toggleSelect(s.id)}
              onClick={() => router.push(`/pr-suggestions/${s.id}`)}
            />
          ))}
        </div>
      )}

      {/* Bulk action bar (only when items are selected) */}
      <AnimatePresence>
        {selected.size > 0 && (
          <BulkActionBar
            selected={Array.from(selected)}
            onRegenerate={handleBulkRegenerate}
            onClear={() => setSelected(new Set())}
            busy={bulkBusy}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
