"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  agentForPlan,
  statusCounts,
  type ImprovePlanFixture,
  type ImproveStatus,
} from "@/lab/fixtures/improve";
import { AgentLink, EmptyState, FilterChips } from "@/lab/lab-ui";
import {
  ImproveKindChip,
  ImproveStatusChip,
} from "@/lab/improve/improve-chrome";
import type { ImproveQueueItem } from "@/lib/api";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { cn } from "@/lib/utils";

/** M13 dual-queue columns from `GET /orgs/{id}/improve/queue`. */
type QueueColumnFilter = "fix_now" | "improve_later";
type StatusFilter = "all" | ImproveStatus | QueueColumnFilter;

function planIdFromQueueItem(item: ImproveQueueItem): string | null {
  const fromPayload = item.payload?.plan_id;
  if (typeof fromPayload === "string" && fromPayload) return fromPayload;
  if (item.ref.startsWith("improvement_plan:")) {
    return item.ref.slice("improvement_plan:".length) || null;
  }
  return null;
}

export function ImproveQueueView({
  agentId,
  plans,
  queueItems = [],
  selectedId,
  onSelect,
  onOpenPlan,
}: {
  agentId: string;
  plans: ImprovePlanFixture[];
  /** M13: live cockpit items — drives Fix now / Improve later chips. */
  queueItems?: ImproveQueueItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenPlan: (id: string) => void;
}) {
  const [status, setStatus] = useState<StatusFilter>("needs_you");
  const [query, setQuery] = useState("");

  const scoped = useMemo(() => {
    if (agentId === "all") return plans;
    return plans.filter((p) => p.agentId === agentId);
  }, [plans, agentId]);

  // M13: plan_id → aggregator column (fix_now / improve_later / …).
  const columnByPlanId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of queueItems) {
      const pid = planIdFromQueueItem(item);
      if (pid) map.set(pid, item.column);
    }
    return map;
  }, [queueItems]);

  const hasLiveQueue = columnByPlanId.size > 0;
  const counts = useMemo(() => {
    const base = statusCounts(scoped);
    if (!hasLiveQueue) return base;
    let fixNow = 0;
    let improveLater = 0;
    for (const p of scoped) {
      const col = columnByPlanId.get(p.id);
      if (col === "fix_now") fixNow += 1;
      else if (col === "improve_later") improveLater += 1;
    }
    return { ...base, fix_now: fixNow, improve_later: improveLater };
  }, [scoped, hasLiveQueue, columnByPlanId]);

  // Prefer Fix-now chip once the live cockpit queue is available.
  useEffect(() => {
    if (hasLiveQueue && status === "needs_you") {
      setStatus("fix_now");
    }
  }, [hasLiveQueue, status]);

  // Landing on "No matches" with zero explanation when nothing needs
  // review reads as broken — fall back to the full list.
  useEffect(() => {
    if (!hasLiveQueue) {
      if (
        status === "needs_you" &&
        counts.needs_you === 0 &&
        scoped.length > 0
      ) {
        setStatus("all");
      }
      return;
    }
    if (
      status === "fix_now" &&
      (counts as { fix_now?: number }).fix_now === 0 &&
      scoped.length > 0
    ) {
      const later = (counts as { improve_later?: number }).improve_later ?? 0;
      setStatus(later > 0 ? "improve_later" : "all");
    }
  }, [status, counts, scoped.length, hasLiveQueue]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped.filter((p) => {
      if (hasLiveQueue && (status === "fix_now" || status === "improve_later")) {
        if (columnByPlanId.get(p.id) !== status) return false;
      } else if (status === "needs_you" && hasLiveQueue) {
        // Legacy chip → Fix now column when live queue is present.
        if (columnByPlanId.get(p.id) !== "fix_now") return false;
      } else if (status !== "all" && status !== "fix_now" && status !== "improve_later") {
        if (p.status !== status) return false;
      }
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
      );
    });
  }, [scoped, status, query, hasLiveQueue, columnByPlanId]);

  const selected =
    rows.find((p) => p.id === selectedId) ??
    scoped.find((p) => p.id === selectedId) ??
    rows[0] ??
    null;

  const filterOptions = hasLiveQueue
    ? [
        { id: "all" as const, label: "All", count: counts.all },
        {
          id: "fix_now" as const,
          label: "Fix now",
          count: (counts as { fix_now?: number }).fix_now ?? 0,
        },
        {
          id: "improve_later" as const,
          label: "Improve later",
          count: (counts as { improve_later?: number }).improve_later ?? 0,
        },
        {
          id: "in_progress" as const,
          label: "In progress",
          count: counts.in_progress,
        },
        { id: "verify" as const, label: "Verify", count: counts.verify },
        { id: "done" as const, label: "Done", count: counts.done },
      ]
    : [
        { id: "all" as const, label: "All", count: counts.all },
        {
          id: "needs_you" as const,
          label: "Fix now",
          count: counts.needs_you,
        },
        {
          id: "in_progress" as const,
          label: "In progress",
          count: counts.in_progress,
        },
        { id: "verify" as const, label: "Verify", count: counts.verify },
        { id: "done" as const, label: "Done", count: counts.done },
      ];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-3 sm:px-6">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plans…"
            className="ds-input min-w-[10rem] flex-1 !h-8 !py-0 !text-[0.75rem] sm:max-w-xs"
            aria-label="Search improve plans"
          />
          <FilterChips
            value={status}
            onChange={setStatus}
            scroll
            options={filterOptions}
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            compact
            title={scoped.length === 0 ? "No improve work" : "No matches"}
            body={
              scoped.length === 0
                ? U20_EMPTY_COPY.improveQueue
                : undefined
            }
            action={
              status !== "all" ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => setStatus("all")}
                >
                  Show all
                </button>
              ) : scoped.length === 0 ? (
                <Link href="/issues" className="ds-btn ds-btn-primary ds-btn-sm">
                  Open Issues
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((p) => {
              const agent = agentForPlan(p);
              const active = p.id === selected?.id;
              const column = columnByPlanId.get(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(p.id)}
                    onDoubleClick={() => onOpenPlan(p.id)}
                    className={cn(
                      "flex w-full flex-col gap-1.5 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6",
                      active && "bg-[var(--accent-muted)]",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <ImproveStatusChip status={p.status} />
                      <ImproveKindChip kind={p.kind} />
                      {column === "fix_now" || column === "improve_later" ? (
                        <span className="type-meta text-[var(--text-faint)]">
                          {column === "fix_now" ? "Fix now" : "Improve later"}
                        </span>
                      ) : null}
                      <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                        {p.title}
                      </span>
                    </div>
                    <p className="type-body line-clamp-1">{p.summary}</p>
                    <p className="type-meta">
                      {agent?.name ?? p.agentId}
                      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                      {p.updatedAt}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {rows.length === 0 ? null : (
        <div className="flex min-h-[14rem] w-full shrink-0 flex-col lg:w-[22rem] lg:min-h-0">
          {selected ? (
            <QueuePeek
              plan={selected}
              onOpen={() => onOpenPlan(selected.id)}
            />
          ) : (
            <EmptyState
              compact
              title="Select a plan"
              body="Pick a plan from the queue to preview RCA and open the full plan."
            />
          )}
        </div>
      )}
    </div>
  );
}

function QueuePeek({
  plan,
  onOpen,
}: {
  plan: ImprovePlanFixture;
  onOpen: () => void;
}) {
  const agent = agentForPlan(plan);
  return (
    <div className="flex h-full flex-col border-t border-[var(--line)] bg-[var(--bg-inset)] px-4 py-4 sm:px-6 lg:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <ImproveStatusChip status={plan.status} />
        <ImproveKindChip kind={plan.kind} />
      </div>
      <h2 className="type-ui mt-3 text-[var(--text)]">{plan.title}</h2>
      <p className="type-meta mt-1">
        <AgentLink agentId={agent?.id} name={agent?.name ?? plan.agentId} />
        <span className="mx-1.5 text-[var(--text-faint)]">·</span>
        {plan.updatedAt}
      </p>
      <p className="type-body mt-4 text-[var(--text-secondary)]">{plan.rca}</p>
      <div className="mt-auto flex flex-wrap gap-1 pt-4">
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm"
          onClick={onOpen}
        >
          Open plan
        </button>
      </div>
    </div>
  );
}
