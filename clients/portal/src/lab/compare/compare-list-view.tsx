"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import {
  agentLabel,
  armDelta,
  formatDeltaDisplay,
  metricShortLabel,
  verdictLabel,
  type AbExperimentFixture,
  type AbStatus,
} from "@/lab/fixtures/compare";
import { AbRecChip } from "@/lab/compare/compare-chrome";
import { AgentScopeFilter, EmptyState, FilterChips } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

export function CompareListView({
  experiments,
  activeId,
  query,
  onQueryChange,
  agentId,
  onAgentChange,
  statusFilter,
  onStatusFilter,
  onSelect,
  counts,
}: {
  experiments: AbExperimentFixture[];
  activeId: string | null;
  query: string;
  onQueryChange: (v: string) => void;
  agentId: string;
  onAgentChange: (id: string) => void;
  statusFilter: AbStatus | "all";
  onStatusFilter: (v: AbStatus | "all") => void;
  onSelect: (id: string) => void;
  counts?: Record<string, number>;
}) {
  const q = query.trim().toLowerCase();
  const filtered = experiments.filter((e) => {
    if (agentId !== "all" && e.agentId !== agentId) return false;
    if (statusFilter !== "all" && e.status !== statusFilter) return false;
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      agentLabel(e.agentId).toLowerCase().includes(q) ||
      verdictLabel(e.recommendation).toLowerCase().includes(q)
    );
  });

  const statusOptions: { id: AbStatus | "all"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Live" },
    { id: "winner_detected", label: "Winner" },
    { id: "stopped", label: "Stopped" },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
        <label className="relative min-w-[10rem] flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-secondary)]"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search…"
            className="ds-input w-full !py-1.5 !pl-8"
            aria-label="Search splits"
          />
        </label>
        <AgentScopeFilter
          value={agentId}
          onChange={onAgentChange}
          counts={counts}
        />
      </div>

      <div className="border-b border-[var(--line)] px-4 py-2 sm:px-5">
        <FilterChips
          value={statusFilter}
          onChange={onStatusFilter}
          options={statusOptions}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={
            q || agentId !== "all" || statusFilter !== "all"
              ? "No matches"
              : "No splits"
          }
          action={
            q || agentId !== "all" || statusFilter !== "all" ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => {
                  onQueryChange("");
                  onAgentChange("all");
                  onStatusFilter("all");
                }}
              >
                Clear
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/evals?mode=compare"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                >
                  Evals
                </Link>
                <Link href="/debugger" className="ds-btn ds-btn-sm">
                  Debugger
                </Link>
              </div>
            )
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((e) => {
            const active = e.id === activeId;
            const [control, treatment] = e.arms;
            const primary = armDelta(e, e.primaryMetric);
            const good = primary.invertGood
              ? primary.delta < -0.0005
              : primary.delta > 0.0005;
            const bad = primary.invertGood
              ? primary.delta > 0.0005
              : primary.delta < -0.0005;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors sm:px-5",
                    active
                      ? "bg-[var(--accent-muted)]"
                      : "hover:bg-[var(--bg-inset)]",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <AbRecChip rec={e.recommendation} />
                    <span
                      className={cn(
                        "type-mono tabular-nums !text-[0.6875rem]",
                        good && "!text-[var(--success)]",
                        bad && "!text-[var(--error)]",
                        !good && !bad && "!text-[var(--text-muted)]",
                      )}
                    >
                      {metricShortLabel(e.primaryMetric)}{" "}
                      {formatDeltaDisplay(e.primaryMetric, primary.delta)}
                    </span>
                    <span className="type-meta text-[var(--text-faint)]">
                      {Math.round(e.winnerConfidence * 100)}%
                    </span>
                  </div>
                  <span className="type-ui truncate text-[var(--text)]">
                    {e.name}
                  </span>
                  <span className="type-meta">
                    {agentLabel(e.agentId)} ·{" "}
                    {(control.weight * 100).toFixed(0)}/
                    {(treatment.weight * 100).toFixed(0)} · {e.createdAt}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
