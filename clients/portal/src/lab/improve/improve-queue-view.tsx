"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | ImproveStatus;

export function ImproveQueueView({
  agentId,
  plans,
  selectedId,
  onSelect,
  onOpenPlan,
}: {
  agentId: string;
  plans: ImprovePlanFixture[];
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

  const counts = useMemo(() => statusCounts(scoped), [scoped]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped.filter((p) => {
      if (status !== "all" && p.status !== status) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
      );
    });
  }, [scoped, status, query]);

  const selected =
    rows.find((p) => p.id === selectedId) ??
    scoped.find((p) => p.id === selectedId) ??
    rows[0] ??
    null;

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
            options={[
              { id: "all", label: "All", count: counts.all },
              { id: "needs_you", label: "Needs you", count: counts.needs_you },
              {
                id: "in_progress",
                label: "In progress",
                count: counts.in_progress,
              },
              { id: "verify", label: "Verify", count: counts.verify },
              { id: "done", label: "Done", count: counts.done },
            ]}
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
