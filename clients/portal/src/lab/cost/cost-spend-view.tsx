"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  budgetIsPressure,
  formatSpend,
  type CostBudgetFixture,
} from "@/lab/fixtures/cost";
import { type AgentFixture } from "@/lab/fixtures/agents";
import {
  formatTokens,
  formatUsd,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import { AgentLink, EmptyState } from "@/lab/lab-ui";
import { BudgetChip } from "@/lab/cost/cost-chrome";
import { cn } from "@/lib/utils";

export function CostSpendView({
  agentId,
  agents: agentsProp,
  traces: tracesProp = [],
  budget,
  spendUsd,
  spendEstimated = false,
  spendSourceLabel = "Telemetry · 24h",
  onFilterAgent,
  onGoDrivers,
}: {
  agentId: string;
  agents: AgentFixture[];
  traces?: TraceFixture[];
  budget: CostBudgetFixture;
  /** Single primary spend figure from the page (catalog/telemetry). */
  spendUsd: number | null;
  spendEstimated?: boolean;
  spendSourceLabel?: string;
  onFilterAgent: (id: string) => void;
  onGoDrivers: () => void;
}) {
  const agents = useMemo(() => {
    const sorted = [...agentsProp].sort((a, b) => {
      const ac = a.costUsd24h;
      const bc = b.costUsd24h;
      if (ac == null && bc == null) return 0;
      if (ac == null) return 1;
      if (bc == null) return -1;
      return bc - ac;
    });
    if (agentId === "all") return sorted;
    return sorted.filter((a) => a.id === agentId);
  }, [agentsProp, agentId]);

  const traces = useMemo(() => {
    const list =
      agentId === "all"
        ? tracesProp
        : tracesProp.filter((t) => t.agentId === agentId);
    return [...list]
      .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1))
      .slice(0, 8);
  }, [tracesProp, agentId]);

  const agentByIdLocal = useMemo(() => {
    const map = new Map(agentsProp.map((a) => [a.id, a]));
    return (id: string) => map.get(id);
  }, [agentsProp]);

  const spend = spendUsd;
  const runs =
    agentId === "all"
      ? agentsProp.reduce((s, a) => s + a.runs24h, 0)
      : (agentByIdLocal(agentId)?.runs24h ?? 0);
  const avg = runs && spend != null ? spend / runs : null;

  const showOrgBudget = agentId === "all";
  const pct = Math.min(
    100,
    budget.limitUsd > 0
      ? Math.round((budget.spentUsd / budget.limitUsd) * 100)
      : 0,
  );
  const pressure = budgetIsPressure(budget.status);
  const runsHref =
    agentId === "all" ? "/traces" : `/traces?agent=${agentId}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* First viewport: one job — Spend. Runs is secondary context only. */}
      <div className="grid shrink-0 gap-px border-b border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
        <Kpi
          label={spendEstimated ? "Est. spend · 24h" : "Spend · 24h"}
          value={formatSpend(spend)}
          hint={
            agentId === "all"
              ? spendSourceLabel
              : agentByIdLocal(agentId)?.name
          }
          primary
        />
        <Kpi
          label="Runs · 24h"
          value={String(runs)}
          href={runsHref}
          hint={`${formatSpend(avg)} / run`}
        />
      </div>

      {/* Drivers tease — below the primary spend job, not an equal KPI. */}
      <div className="shrink-0 border-b border-[var(--line)] px-4 py-2.5 sm:px-6">
        <button
          type="button"
          onClick={onGoDrivers}
          className="type-meta text-[var(--accent)] hover:underline"
        >
          Find savings drivers →
        </button>
      </div>

      {showOrgBudget && budget.limitUsd > 0 ? (
        <div className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              <span className="type-label">{budget.name}</span>
              <span className="type-sep mx-1.5">·</span>
              <span className="type-value">
                <span className={pressure ? "text-[var(--error)]" : undefined}>
                  {formatUsd(budget.spentUsd)}
                </span>
                <span className="text-[var(--text-muted)]">
                  {" "}
                  of {formatUsd(budget.limitUsd)}
                </span>
              </span>
              <span className="type-sep mx-1.5">·</span>
              <span className="type-meta">
                gateway budget (separate from telemetry spend above)
              </span>
            </p>
            <BudgetChip status={budget.status} />
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]">
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                pressure ? "bg-[var(--error)]" : "bg-[var(--success)]",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : null}

      <section className="border-b border-[var(--line)] px-4 py-4 sm:px-6">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="type-label">By agent</p>
          {agentId !== "all" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => onFilterAgent("all")}
            >
              All agents
            </button>
          ) : null}
        </div>
        {agents.length === 0 ? (
          <EmptyState
            compact
            title="No agents"
            body="Connect an agent to see spend by fleet."
            action={
              <Link
                href="/settings?mode=keys"
                className="ds-btn ds-btn-primary ds-btn-sm"
              >
                API keys
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {agents.map((a) => {
              const perRun =
                a.runs24h && a.costUsd24h != null
                  ? a.costUsd24h / a.runs24h
                  : null;
              const active = agentId === a.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onFilterAgent(a.id)}
                    className={cn(
                      "flex w-full flex-wrap items-center gap-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]",
                      active && "bg-[var(--accent-muted)]",
                    )}
                  >
                    <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                      {a.name}
                    </span>
                    <span className="type-value !text-[0.6875rem]">
                      {formatSpend(a.costUsd24h)}
                    </span>
                    <span className="type-meta w-16 text-right">
                      {formatSpend(perRun)}/run
                    </span>
                    <span className="type-meta w-12 text-right">
                      {a.runs24h}
                    </span>
                    <Link
                      href={`/agents?id=${a.id}`}
                      className="type-meta text-[var(--accent)] hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open
                    </Link>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="px-4 py-4 sm:px-6">
        <p className="type-label mb-3">Costliest runs</p>
        {traces.length === 0 ? (
          <EmptyState
            compact
            title="No runs"
            body={
              tracesProp.length === 0
                ? "Traces need to be loaded. Open Traces to inspect costly runs."
                : agentId !== "all"
                  ? "No costly runs for this agent filter."
                  : "No costly runs in the last 24h."
            }
            action={
              <Link href={runsHref} className="ds-btn ds-btn-ghost ds-btn-sm">
                Traces
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {traces.map((t) => {
              const agent = agentByIdLocal(t.agentId);
              return (
                <li key={t.id}>
                  <Link
                    href={`/traces?id=${t.id}&agent=${t.agentId}`}
                    className="flex flex-wrap items-center gap-3 py-2.5 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                      {t.name}
                    </span>
                    <AgentLink
                      agentId={agent?.id}
                      name={agent?.name ?? t.agentId}
                    />
                    <span className="type-meta">{formatTokens(t.tokens)}</span>
                    <span className="type-value !text-[0.6875rem]">
                      {formatUsd(t.costUsd, 3)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  href,
  trailing,
  onClick,
  primary,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  href?: string;
  trailing?: ReactNode;
  onClick?: () => void;
  primary?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="type-label">{label}</p>
        {trailing}
      </div>
      <p
        className={cn(
          "mt-1.5 text-[var(--text)]",
          primary ? "type-display !text-[1.25rem]" : "type-ui",
        )}
      >
        {value}
      </p>
      {hint ? <p className="type-meta mt-1">{hint}</p> : null}
    </>
  );
  const className =
    "block bg-[var(--bg)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6";
  if (href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className={className}>{inner}</div>;
}
