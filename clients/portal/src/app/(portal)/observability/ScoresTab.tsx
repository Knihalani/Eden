"use client";

/**
 * ScoresTab — judge scores for the selected trace.
 *
 * Phase 7.2b: replaces the placeholder. Reads the live judges API
 * for the trace and renders one row per (judge_name, version, span_id).
 * Each row shows the score (color-coded), the rationale, and a
 * "Run judges on this trace" button at the top.
 */

import * as React from "react";
import { Gauge, RefreshCw, Play } from "lucide-react";
import { api } from "@/lib/api";

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
    } finally {
      setLoading(false);
    }
  }, [orgId, traceId]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRun = React.useCallback(async () => {
    if (!traceId) return;
    setRunning(true);
    try {
      await api.runJudges(orgId, { trace_id: traceId });
      // The async tailer picks up the job; give it a moment to land.
      setTimeout(() => refresh(), 1500);
    } catch (err) {
      console.warn("Failed to run judges", err);
    } finally {
      setRunning(false);
    }
  }, [orgId, traceId, refresh]);

  if (!traceId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <Gauge className="mx-auto mb-2 h-8 w-8 text-[var(--text-muted)]" />
          <p className="text-sm text-[var(--text-muted)]">
            Select a trace to view its judge scores.
          </p>
        </div>
      </div>
    );
  }

  if (loading && scores.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-muted)]">
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
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            onClick={handleRun}
            disabled={running}
            className="flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            {running ? "Running…" : "Run judges"}
          </button>
        </div>
      </div>

      {/* Empty state */}
      {scores.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div>
            <Gauge className="mx-auto mb-2 h-8 w-8 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-muted)]">
              No judge scores for this trace yet.
            </p>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Click <span className="font-mono">Run judges</span> to score
              it against correctness, hallucination, and tone.
            </p>
          </div>
        </div>
      )}

      {/* Score rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
            <tr className="border-b border-[var(--border-default)]">
              <th className="px-3 py-1.5 text-left">Judge</th>
              <th className="px-3 py-1.5 text-left">Version</th>
              <th className="px-3 py-1.5 text-right">Score</th>
              <th className="px-3 py-1.5 text-left">Model</th>
              <th className="px-3 py-1.5 text-left">Scored at</th>
              <th className="px-3 py-1.5 text-left">Rationale</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((s) => {
              const sev = scoreSeverity(s.score);
              const isOpen = expanded[s.judge_run_id] ?? false;
              return (
                <tr
                  key={s.judge_run_id}
                  className="border-b border-[var(--border-default)]/50 hover:bg-[var(--bg-secondary)]/50"
                >
                  <td className="px-3 py-2">
                    <span
                      className="font-mono"
                      style={{ color: SEVERITY_COLORS[sev] }}
                    >
                      {s.judge_name}
                    </span>
                    {s.span_id && (
                      <div className="text-[10px] text-[var(--text-muted)]">
                        span: {s.span_id.slice(0, 12)}…
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                    {s.judge_version}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span
                      className="font-mono tabular-nums text-sm"
                      style={{ color: SEVERITY_COLORS[sev] }}
                    >
                      {s.score.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                    {s.model}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                    {s.scored_at}
                  </td>
                  <td className="px-3 py-2">
                    {s.rationale ? (
                      <button
                        onClick={() =>
                          setExpanded((p) => ({
                            ...p,
                            [s.judge_run_id]: !p[s.judge_run_id],
                          }))
                        }
                        className="text-left text-[var(--text-primary)] hover:text-[var(--accent)]"
                      >
                        {isOpen
                          ? s.rationale
                          : s.rationale.length > 200
                          ? s.rationale.slice(0, 200) + "…"
                          : s.rationale}
                      </button>
                    ) : (
                      <span className="text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
