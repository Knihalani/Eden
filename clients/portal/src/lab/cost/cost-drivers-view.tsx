"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  formatSpend,
  type CostDriverFixture,
} from "@/lab/fixtures/cost";
import { agentById } from "@/lab/fixtures/agents";
import { AgentLink, EmptyState } from "@/lab/lab-ui";
import { DriverKindChip } from "@/lab/cost/cost-chrome";
import { cn } from "@/lib/utils";

export function CostDriversView({
  agentId,
  drivers,
  selectedId,
  onSelect,
}: {
  agentId: string;
  drivers: CostDriverFixture[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const filtered =
      agentId === "all"
        ? drivers
        : drivers.filter((d) => d.agentId === agentId);
    return [...filtered].sort((a, b) => b.estSaveUsd - a.estSaveUsd);
  }, [drivers, agentId]);
  const selected = rows.find((d) => d.id === selectedId) ?? rows[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        {rows.length === 0 ? (
          <EmptyState
            compact
            title="No cost drivers yet"
            body="Drivers appear after agents spend on LLM calls. Open Spend for totals, or send traffic with an API key."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/cost?mode=spend" className="ds-btn ds-btn-ghost ds-btn-sm">
                  Spend
                </Link>
                <Link href="/settings?mode=keys" className="ds-btn ds-btn-primary ds-btn-sm">
                  API keys
                </Link>
              </div>
            }
          />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((d) => {
              const agent = agentById(d.agentId);
              const active = d.id === selected?.id;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(d.id)}
                    className={cn(
                      "flex w-full flex-col gap-1.5 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6",
                      active && "bg-[var(--accent-muted)]",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <DriverKindChip kind={d.kind} />
                      <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                        {d.title}
                      </span>
                      {d.estSaveUsd > 0 ? (
                        <span className="type-value !text-[0.6875rem] !text-[var(--success)]">
                          −{formatSpend(d.estSaveUsd)}
                        </span>
                      ) : (
                        <span className="type-meta">ok</span>
                      )}
                    </div>
                    <p className="type-body line-clamp-1">{d.summary}</p>
                    <p className="type-meta">
                      {agent?.name ?? d.agentId}
                      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                      {d.confidence} confidence
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {rows.length === 0 ? null : (
      <div className="flex min-h-[14rem] w-full shrink-0 flex-col lg:w-[24rem] lg:min-h-0">
        {selected ? (
          <DriverDetail driver={selected} />
        ) : (
          <EmptyState
            compact
            title="Select a driver"
            body="Pick a row to see savings, evidence traces, and next actions."
          />
        )}
      </div>
      )}
    </div>
  );
}

function DriverDetail({ driver }: { driver: CostDriverFixture }) {
  const agent = agentById(driver.agentId);
  const primary = primaryHref(driver);

  return (
    <div className="flex h-full flex-col border-t border-[var(--line)] bg-[var(--bg-inset)] px-4 py-4 sm:px-6 lg:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <DriverKindChip kind={driver.kind} />
        {driver.estSaveUsd > 0 ? (
          <span className="type-value !text-[0.6875rem] !text-[var(--success)]">
            save ~{formatSpend(driver.estSaveUsd)}
          </span>
        ) : null}
      </div>
      <h2 className="type-ui mt-3 text-[var(--text)]">{driver.title}</h2>
      <p className="type-meta mt-1">
        <AgentLink
          agentId={agent?.id}
          name={agent?.name ?? driver.agentId}
        />
        <span className="mx-1.5 text-[var(--text-faint)]">·</span>
        {driver.confidence} confidence
      </p>
      <p className="type-body mt-4 text-[var(--text-secondary)]">
        {driver.summary}
      </p>

      {driver.traceIds.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {driver.traceIds.map((id) => (
            <Link
              key={id}
              href={`/traces?id=${id}&agent=${driver.agentId}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Trace {id}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-1 pt-4">
        {primary ? (
          <Link href={primary.href} className="ds-btn ds-btn-primary ds-btn-sm">
            {primary.label}
          </Link>
        ) : null}
        <Link
          href={`/agents?id=${driver.agentId}`}
          className="ds-btn ds-btn-ghost ds-btn-sm"
        >
          Agent
        </Link>
      </div>
    </div>
  );
}

function primaryHref(
  d: CostDriverFixture,
): { href: string; label: string } | null {
  if (d.primaryAction === "open_improve" && d.improvePlanId) {
    return {
      href: `/improve?mode=plan&id=${d.improvePlanId}&agent=${d.agentId}`,
      label: "Improve",
    };
  }
  if (
    d.primaryAction === "open_evals" &&
    d.baselineId &&
    d.compareId
  ) {
    return {
      href: `/evals?baselineId=${d.baselineId}&compareId=${d.compareId}`,
      label: "Open Evals",
    };
  }
  if (d.primaryAction === "open_traces" && d.traceIds[0]) {
    return {
      href: `/traces?id=${d.traceIds[0]}&agent=${d.agentId}`,
      label: "Open traces",
    };
  }
  if (d.primaryAction === "open_agent") {
    return {
      href: `/agents?id=${d.agentId}`,
      label: "Open agent",
    };
  }
  return null;
}
