"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { StatusBadge } from "@/components/ui/status-badge";
import { MetricInline } from "@/components/ui/metric-inline";
import {
  AGENT_HEALTH_STATUSES,
  type AgentOsRow,
} from "@/lib/agent-health";
import { cn } from "@/lib/utils";

function formatRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type Props = {
  agents: AgentOsRow[];
  highlightAgentId?: string | null;
};

export function AgentOsList({ agents, highlightAgentId }: Props) {
  const t = useTranslations("dashboard.agents");
  const router = useRouter();
  const initial = Math.max(
    0,
    agents.findIndex((a) => a.agentId === highlightAgentId),
  );
  const [focusedIndex, setFocusedIndex] = useState(initial >= 0 ? initial : 0);

  useListKeyboardNav(
    agents.length,
    focusedIndex,
    (idx) => {
      setFocusedIndex(idx);
      const row = agents[idx];
      if (row) router.push(`/agents/${encodeURIComponent(row.agentId)}`);
    },
    agents.length > 0,
  );

  return (
    <section
      className="min-w-0"
      data-testid="dashboard-agent-os-list"
      aria-label={t("title")}
    >
      <h2 className="mb-2 text-sm font-medium text-[var(--text-primary)]">
        {t("titleCount", { count: agents.length })}
      </h2>
      <ul className="m-0 list-none space-y-0 border border-[var(--border-subtle)] rounded-md divide-y divide-[var(--border-subtle)] p-0">
        {agents.map((row, index) => (
          <li key={row.agentId}>
            <button
              type="button"
              data-focused={focusedIndex === index ? "true" : "false"}
              className={cn(
                "flex w-full min-h-11 items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors",
                "hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--terminal)]",
                focusedIndex === index && "bg-[var(--bg-tertiary)]",
                highlightAgentId === row.agentId && "ring-1 ring-inset ring-[var(--accent)]/40",
              )}
              onClick={() =>
                router.push(`/agents/${encodeURIComponent(row.agentId)}`)
              }
              onFocus={() => setFocusedIndex(index)}
            >
              <StatusBadge
                status={row.status}
                descriptors={AGENT_HEALTH_STATUSES}
                iconOnly
                className="shrink-0"
              />
              <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
                <Link
                  href={`/agents/${encodeURIComponent(row.agentId)}`}
                  className="hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.displayName}
                </Link>
              </span>
              <MetricInline
                label={t("err")}
                value={formatRate(row.errorRate)}
                mono
                className="hidden sm:inline-flex"
              />
              <span className="hidden font-mono text-[var(--text-secondary)] md:inline">
                {formatUsd(row.costUsd)}
              </span>
              <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
                {formatRelative(row.lastSeenAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
