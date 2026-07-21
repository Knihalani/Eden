"use client";

/**
 * ScoresTab — judge scores for the selected trace.
 *
 * Phase 7.2b: replaces the placeholder. Reads the live judges API
 * for the trace and renders one row per (judge_name, version, span_id).
 * Each row shows the score (color-coded), the rationale, and a
 * "Run judges on this trace" button at the top.
 *
 * June 2026 polish: judge multi-select (was: all-or-nothing), toast
 * feedback (was: silent failure), explicit loading state during the
 * 1500ms post-run wait (was: button just sat there).
 */

import * as React from "react";
import { Gauge, RefreshCw, Play, Check, ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface ScoresTabProps {
  orgId: string;
  traceId?: string;
}

const SEVERITY_COLORS = {
  high: "var(--error)",
  warning: "var(--warning)",
  low: "var(--terminal)",
};

function scoreSeverity(score: number): "high" | "warning" | "low" {
  if (score < 0.3) return "high";
  if (score < 0.7) return "warning";
  return "low";
}

export function ScoresTab({ orgId, traceId }: ScoresTabProps) {
  const toast = useToast();
  const [scores, setScores] = React.useState<Array<{
    judge_run_id: string;
    trace_id: string;
    span_id?: string | null;
    judge_name: string;
    judge_version: string;
    score: number;
    rationale?: string | null;
    model: string;
    scored_at: string;
    latency_ms?: number;
  }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  // June 2026: judge multi-select. Empty set = "all judges" (matches
  // the existing backend semantics where omitting `judge_names` runs
  // every registered judge).
  const [selectedJudges, setSelectedJudges] = React.useState<Set<string>>(
    new Set(),
  );
  const [judgePickerOpen, setJudgePickerOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!traceId) return;
    setLoading(true);
    try {
      const result = await api.listJudgeScores(orgId, { trace_id: traceId, limit: 50 });
      // The API returns ``latency_ms: number | null``; the local
      // state uses ``number | undefined`` (we never surface ``null``).
      // Coerce at the boundary so the rest of the component stays
      // strictly-typed.
      setScores(
        result.scores.map((s) => ({
          ...s,
          latency_ms: s.latency_ms ?? undefined,
        })),
      );
    } catch (err) {
      console.warn("Failed to load judge scores", err);
      toast.error("Failed to load judge scores");
    } finally {
      setLoading(false);
    }
  }, [orgId, traceId, toast]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Distinct judge names seen for this trace — feed the multi-select.
  const availableJudges = React.useMemo(() => {
    const seen = new Set<string>();
    for (const s of scores) seen.add(s.judge_name);
    return Array.from(seen).sort();
  }, [scores]);

  const handleRun = React.useCallback(async () => {
    if (!traceId) return;
    setRunning(true);
    try {
      const judge_names = selectedJudges.size > 0 ? Array.from(selectedJudges) : null;
      await api.runJudges(orgId, { trace_id: traceId, judge_names });
      toast.success(
        judge_names
          ? `Running ${judge_names.length} judge${judge_names.length === 1 ? "" : "s"}…`
          : "Running all judges…",
      );
      // The async tailer picks up the job; give it a moment to land.
      // While we wait, the Running… state stays so the user sees
      // immediate feedback.
      setTimeout(async () => {
        await refresh();
        setRunning(false);
      }, 1500);
    } catch (err) {
      console.warn("Failed to run judges", err);
      toast.error(err instanceof Error ? err.message : "Failed to run judges");
      setRunning(false);
    }
  }, [orgId, traceId, refresh, selectedJudges, toast]);

  const toggleJudge = React.useCallback((name: string) => {
    setSelectedJudges((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  if (!traceId) {
    return (
      <EmptyState
        icon={Gauge}
        title="Select a trace"
        description="Select a trace to view its judge scores."
        size="md"
        className="h-full flex items-center justify-center"
      />
    );
  }

  if (loading && scores.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading scores…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-2">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="text-sm font-medium">
            Judge scores
            <span className="ml-2 text-xs text-[var(--text-muted)]">
              {scores.length} {scores.length === 1 ? "row" : "rows"}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* June 2026: judge multi-select. Only shown when we have
             at least one judge name in the current result set (so we
             know what to filter by). */}
          {availableJudges.length > 0 && (
            <div className="relative">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setJudgePickerOpen((p) => !p)}
              >
                {selectedJudges.size === 0
                  ? "All judges"
                  : `${selectedJudges.size} judge${selectedJudges.size === 1 ? "" : "s"}`}
                <ChevronDown className="h-3 w-3" />
              </Button>
              {judgePickerOpen && (
                <div className="absolute right-0 z-10 mt-1 min-w-[180px] rounded border border-[var(--border-default)] bg-[var(--bg-primary)] py-1 shadow-md">
                  {availableJudges.map((name) => {
                    const checked = selectedJudges.has(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => toggleJudge(name)}
                        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <span className="flex h-3 w-3 items-center justify-center rounded border border-[var(--border-default)]">
                          {checked ? <Check className="h-2.5 w-2.5" /> : null}
                        </span>
                        <span className="font-mono">{name}</span>
                      </button>
                    );
                  })}
                  {selectedJudges.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedJudges(new Set())}
                      className="block w-full border-t border-[var(--border-default)] px-2 py-1 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
                    >
                      Clear selection
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void handleRun()}
            disabled={running}
            loading={running}
          >
            {!running && <Play className="h-3 w-3" />}
            {running ? "Running…" : "Run judges"}
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {scores.length === 0 && (
        <EmptyState
          icon={Gauge}
          title="No judge scores for this trace yet"
          description={
            <>
              Click <span className="font-mono">Run judges</span> to score it
              against correctness, hallucination, and tone.
            </>
          }
          size="md"
          className="flex-1 flex items-center justify-center"
        />
      )}

      {/* Score rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DataTable
          columns={[
            {
              key: "judge_name",
              header: "Judge",
              sortable: true,
              cell: (s) => {
                const sev = scoreSeverity(s.score);
                return (
                  <div>
                    <span className="font-mono" style={{ color: SEVERITY_COLORS[sev] }}>
                      {s.judge_name}
                    </span>
                    {s.span_id && (
                      <div className="text-2xs text-[var(--text-muted)]">
                        span: {s.span_id.slice(0, 12)}…
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              key: "judge_version",
              header: "Version",
              cell: (s) => <span className="font-mono text-2xs text-[var(--text-muted)]">{s.judge_version}</span>,
            },
            {
              key: "score",
              header: "Score",
              sortable: true,
              align: "right",
              cell: (s) => {
                const sev = scoreSeverity(s.score);
                return (
                  <span className="font-mono tabular-nums text-sm" style={{ color: SEVERITY_COLORS[sev] }}>
                    {s.score.toFixed(2)}
                  </span>
                );
              },
            },
            {
              key: "model",
              header: "Model",
              cell: (s) => <span className="font-mono text-2xs text-[var(--text-muted)]">{s.model}</span>,
            },
            {
              key: "scored_at",
              header: "Scored at",
              sortable: true,
              cell: (s) => <span className="font-mono text-2xs text-[var(--text-muted)]">{s.scored_at}</span>,
            },
            {
              key: "rationale",
              header: "Rationale",
              cell: (s) => {
                const isOpen = expanded[s.judge_run_id] ?? false;
                return s.rationale ? (
                  <button
                    onClick={() =>
                      setExpanded((p) => ({ ...p, [s.judge_run_id]: !p[s.judge_run_id] }))
                    }
                    className="text-left text-[var(--text-primary)] hover:text-[var(--accent)]"
                  >
                    {isOpen ? s.rationale : s.rationale.length > 200 ? s.rationale.slice(0, 200) + "…" : s.rationale}
                  </button>
                ) : (
                  <span className="text-[var(--text-muted)]">—</span>
                );
              },
            },
          ]}
          rows={scores}
          rowKey={(s) => s.judge_run_id}
          defaultSort={{ key: "score", direction: "desc" }}
          emptyTitle="No judge scores yet"
          emptyDescription="Run judges to score this trace."
          emptyIcon={Gauge}
          pageSize={50}
        />
      </div>
    </div>
  );
}
