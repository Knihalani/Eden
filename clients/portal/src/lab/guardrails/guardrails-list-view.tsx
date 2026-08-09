"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import {
  agentLabel,
  GUARDRAIL_KINDS,
  GUARDRAIL_STATUSES,
  matchesLine,
  kindLabel,
  statusLabel,
  type GuardrailKind,
  type GuardrailPolicyFixture,
  type GuardrailStatus,
} from "@/lab/fixtures/guardrails";
import {
  GuardrailActionChip,
  GuardrailKindChip,
  GuardrailStatusChip,
} from "@/lab/guardrails/guardrails-chrome";
import { AgentScopeFilter, EmptyState, FilterChips } from "@/lab/lab-ui";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { cn } from "@/lib/utils";

export function GuardrailsListView({
  policies,
  activeId,
  query,
  onQueryChange,
  agentId,
  onAgentChange,
  kindFilter,
  onKindFilter,
  statusFilter,
  onStatusFilter,
  onSelect,
  counts,
}: {
  policies: GuardrailPolicyFixture[];
  activeId: string | null;
  query: string;
  onQueryChange: (v: string) => void;
  agentId: string;
  onAgentChange: (id: string) => void;
  kindFilter: GuardrailKind | "all";
  onKindFilter: (v: GuardrailKind | "all") => void;
  statusFilter: GuardrailStatus | "all";
  onStatusFilter: (v: GuardrailStatus | "all") => void;
  onSelect: (id: string) => void;
  counts?: Record<string, number>;
}) {
  const q = query.trim().toLowerCase();
  const filtered = policies.filter((p) => {
    // Fleet-wide policies (no agentId) stay visible when scoped.
    if (agentId !== "all" && p.agentId && p.agentId !== agentId) return false;
    if (kindFilter !== "all" && p.kind !== kindFilter) return false;
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      (p.ruleSummary ?? "").toLowerCase().includes(q) ||
      agentLabel(p.agentId).toLowerCase().includes(q)
    );
  });

  const kindOptions: { id: GuardrailKind | "all"; label: string }[] = [
    { id: "all", label: "All" },
    ...GUARDRAIL_KINDS.map((kind) => ({
      id: kind,
      label: kindLabel(kind),
    })),
  ];

  const statusOptions: { id: GuardrailStatus | "all"; label: string }[] = [
    { id: "all", label: "All" },
    ...GUARDRAIL_STATUSES.map((status) => ({
      id: status,
      label: statusLabel(status),
    })),
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
            aria-label="Search policies"
          />
        </label>
        <AgentScopeFilter
          value={agentId}
          onChange={onAgentChange}
          counts={counts}
        />
      </div>

      <div className="space-y-2 border-b border-[var(--line)] px-4 py-2 sm:px-5">
        <FilterChips
          value={kindFilter}
          onChange={onKindFilter}
          options={kindOptions}
          scroll
        />
        <FilterChips
          value={statusFilter}
          onChange={onStatusFilter}
          options={statusOptions}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={
            q ||
            agentId !== "all" ||
            kindFilter !== "all" ||
            statusFilter !== "all"
              ? "No matches"
              : "No policies"
          }
          body={
            q ||
            agentId !== "all" ||
            kindFilter !== "all" ||
            statusFilter !== "all"
              ? undefined
              : U20_EMPTY_COPY.guardrailsPolicies
          }
          action={
            q ||
            agentId !== "all" ||
            kindFilter !== "all" ||
            statusFilter !== "all" ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => {
                  onQueryChange("");
                  onAgentChange("all");
                  onKindFilter("all");
                  onStatusFilter("all");
                }}
              >
                Clear
              </button>
            ) : (
              <Link
                href="/traces"
                className="ds-btn ds-btn-primary ds-btn-sm"
              >
                Review traces
              </Link>
            )
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((p) => {
            const active = p.id === activeId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors sm:px-5",
                    active
                      ? "bg-[var(--accent-muted)]"
                      : "hover:bg-[var(--bg-inset)]",
                    p.status === "disabled" && !active && "opacity-60",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <GuardrailKindChip kind={p.kind} />
                    <GuardrailStatusChip status={p.status} />
                    <GuardrailActionChip action={p.action} />
                  </div>
                  <span className="type-ui truncate text-[var(--text)]">
                    {p.name}
                  </span>
                  <span className="type-meta">
                    {agentLabel(p.agentId)} · {matchesLine(p)}
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
