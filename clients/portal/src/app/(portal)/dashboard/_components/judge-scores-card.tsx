"use client";

import Link from "next/link";
import { Loader2, Gavel, ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface JudgeScoreRow {
  judge_run_id: string;
  judge_name: string;
  judge_version: string;
  trace_id: string;
  span_id: string | null;
  score: number;
  rationale: string | null;
  model: string | null;
  scored_at: string;
  latency_ms: number;
}

interface JudgeScoresCardProps {
  loading: boolean;
  scores: JudgeScoreRow[];
}

export function JudgeScoresCard({ loading, scores }: JudgeScoresCardProps) {
  const top = scores.slice(0, 5);
  const empty = !loading && top.length === 0;

  return (
    <div className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Lowest Judge Scores
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">last 24h</p>
        </div>
        <Gavel className="w-5 h-5 text-[var(--text-muted)]" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : empty ? (
        <div className="text-center py-8">
          <Gavel className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] stroke-1 opacity-60" />
          <p className="text-sm text-[var(--text-secondary)]">No judge scores yet</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Once evaluators score your traces, the lowest 5 will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {top.map((s) => (
            <li key={s.judge_run_id}>
              <Link
                href={`/observability/traces/${encodeURIComponent(s.trace_id)}`}
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border-subtle)] hover:border-[var(--border-default)] hover:bg-[var(--bg-secondary)] transition-colors group"
              >
                <ScoreBadge score={s.score} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {s.judge_name}
                    <span className="ml-1.5 text-xs text-[var(--text-muted)] font-normal">
                      v{s.judge_version}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--text-muted)] truncate font-mono">
                    {s.trace_id.slice(0, 12)}…
                    {s.rationale && <span className="ml-1.5 font-sans">— {s.rationale}</span>}
                  </p>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const isLow = score < 0.5;
  const isMid = score >= 0.5 && score < 0.8;
  const bg = isLow
    ? "bg-[var(--error-bg)] text-[var(--error)]"
    : isMid
      ? "bg-[var(--warning-bg)] text-[var(--warning-strong)]"
      : "bg-[var(--success-bg)] text-[var(--success-strong)]";

  return (
    <div
      className={cn(
        "shrink-0 w-12 h-12 rounded-lg flex flex-col items-center justify-center font-semibold",
        bg
      )}
      title={`Score: ${score.toFixed(2)}`}
    >
      {isLow && <AlertTriangle className="w-3 h-3 mb-0.5" />}
      <span className="text-sm leading-none">{score.toFixed(2)}</span>
    </div>
  );
}
