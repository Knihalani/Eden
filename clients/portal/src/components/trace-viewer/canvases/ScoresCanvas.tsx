"use client";

import * as React from "react";
import { Gauge, RefreshCw, Play, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";

type JudgeScore = {
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
};

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

export interface ScoresCanvasProps {
  orgId: string;
  traceId: string;
}

/** Native scores surface — loading / error / empty / rows. */
export function ScoresCanvas({ orgId, traceId }: ScoresCanvasProps) {
  const [scores, setScores] = React.useState<JudgeScore[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listJudgeScores(orgId, {
        trace_id: traceId,
        limit: 50,
      });
      setScores(
        result.scores.map((s) => ({
          ...s,
          latency_ms: s.latency_ms ?? undefined,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load judge scores");
      setScores([]);
    } finally {
      setLoading(false);
    }
  }, [orgId, traceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRun = React.useCallback(async () => {
    setRunning(true);
    try {
      await api.runJudges(orgId, { trace_id: traceId, judge_names: null });
      window.setTimeout(() => {
        void refresh().finally(() => setRunning(false));
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run judges");
      setRunning(false);
    }
  }, [orgId, traceId, refresh]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="scores-canvas"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Judge scores
            {!loading && !error ? (
              <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                {scores.length} {scores.length === 1 ? "row" : "rows"}
              </span>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || running}
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
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

      {loading && scores.length === 0 ? (
        <div
          className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-[var(--text-muted)]"
          data-testid="scores-canvas-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading scores…
        </div>
      ) : error && scores.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <ErrorState
            title="Could not load scores"
            message={error}
            onRetry={() => void refresh()}
          />
        </div>
      ) : scores.length === 0 ? (
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
          className="flex flex-1 items-center justify-center"
        />
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="scores-canvas-list">
          {scores.map((s) => {
            const sev = scoreSeverity(s.score);
            const open = expanded[s.judge_run_id] ?? false;
            return (
              <li
                key={s.judge_run_id}
                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div
                      className="font-mono text-sm font-medium"
                      style={{ color: SEVERITY_COLORS[sev] }}
                    >
                      {s.judge_name}
                      <span className="ml-2 text-2xs font-normal text-[var(--text-muted)]">
                        {s.judge_version}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-2xs text-[var(--text-muted)]">
                      {s.model}
                      {s.span_id ? ` · span ${s.span_id.slice(0, 12)}…` : ""}
                      {" · "}
                      {s.scored_at}
                    </div>
                  </div>
                  <span
                    className="shrink-0 font-mono text-lg tabular-nums"
                    style={{ color: SEVERITY_COLORS[sev] }}
                  >
                    {s.score.toFixed(2)}
                  </span>
                </div>
                {s.rationale ? (
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((p) => ({
                        ...p,
                        [s.judge_run_id]: !p[s.judge_run_id],
                      }))
                    }
                    className="mt-2 w-full text-left text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    {open
                      ? s.rationale
                      : s.rationale.length > 180
                        ? `${s.rationale.slice(0, 180)}…`
                        : s.rationale}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
