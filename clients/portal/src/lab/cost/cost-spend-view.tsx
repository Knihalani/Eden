"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  agentsBySpend,
  avgCostPerRun,
  budgetIsPressure,
  costlyTraces,
  fleetRuns24h,
  fleetSpend24h,
  formatSpend,
  type CostBudgetFixture,
} from "@/lab/fixtures/cost";
import { agentById } from "@/lab/fixtures/agents";
import { formatTokens, formatUsd } from "@/lab/fixtures/traces";
import { AgentLink, EmptyState } from "@/lab/lab-ui";
import { BudgetChip } from "@/lab/cost/cost-chrome";
import { cn } from "@/lib/utils";

export function CostSpendView({
  agentId,
  budget,
  onFilterAgent,
  onGoDrivers,
}: {
  agentId: string;
  budget: CostBudgetFixture;
  onFilterAgent: (id: string) => void;
  onGoDrivers: () => void;
}) {
  const agents = useMemo(() => {
    const list = agentsBySpend();
    if (agentId === "all") return list;
    return list.filter((a) => a.id === agentId);
  }, [agentId]);

  const traces = useMemo(() => costlyTraces(agentId, 8), [agentId]);

  const spend =
    agentId === "all"
      ? fleetSpend24h()
      : (agentById(agentId)?.costUsd24h ?? 0);
  const runs =
    agentId === "all"
      ? fleetRuns24h()
      : (agentById(agentId)?.runs24h ?? 0);
  const avg =
    agentId === "all"
      ? avgCostPerRun()
      : runs
        ? spend / runs
        : 0;

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
      <div className="grid shrink-0 gap-px border-b border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
        <Kpi
          label="Spend · 24h"
          value={formatSpend(spend)}
          hint={agentId === "all" ? "Fleet" : agentById(agentId)?.name}
        />
        <Kpi
          label="Runs · 24h"
          value={String(runs)}
          href={runsHref}
          hint={`${formatSpend(avg)} / run`}
        />
        {showOrgBudget ? (
          <Kpi
            label="Budget"
            value={
              <>
                <span className={pressure ? "text-[var(--error)]" : undefined}>
                  {formatUsd(budget.spentUsd)}
                </span>
                <span className="text-[var(--text-muted)]">
                  {" "}
                  / {formatUsd(budget.limitUsd)}
                </span>
              </>
            }
            hint={`${pct}% · open drivers`}
            onClick={onGoDrivers}
          />
        ) : (
          <Kpi
            label="Drivers"
            value="Open"
            hint="Find savings for this agent"
            onClick={onGoDrivers}
          />
        )}
      </div>

      {showOrgBudget ? (
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
          <EmptyState compact title="No agents" />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {agents.map((a) => {
              const perRun = a.runs24h ? a.costUsd24h / a.runs24h : 0;
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
          <EmptyState compact title="No runs" />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {traces.map((t) => {
              const agent = agentById(t.agentId);
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
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  href?: string;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="type-label">{label}</p>
        {trailing}
      </div>
      <p className="type-ui mt-1.5 text-[var(--text)]">{value}</p>
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
