"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import {
  agentLabel,
  formatFailRate,
  liveVersion,
  type PromptFixture,
  type PromptStatus,
} from "@/lab/fixtures/prompts";
import { PromptStatusChip } from "@/lab/prompts/prompts-chrome";
import { AgentScopeFilter, EmptyState, FilterChips } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

export function PromptsListView({
  prompts,
  activeId,
  query,
  onQueryChange,
  agentId,
  onAgentChange,
  statusFilter,
  onStatusFilter,
  onSelect,
  onNew,
  counts,
}: {
  prompts: PromptFixture[];
  activeId: string | null;
  query: string;
  onQueryChange: (v: string) => void;
  agentId: string;
  onAgentChange: (id: string) => void;
  statusFilter: PromptStatus | "all";
  onStatusFilter: (v: PromptStatus | "all") => void;
  onSelect: (id: string) => void;
  onNew: () => void | Promise<void>;
  counts?: Record<string, number>;
}) {
  const [creating, setCreating] = useState(false);
  const q = query.trim().toLowerCase();
  const filtered = prompts.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      agentLabel(p.agentId).toLowerCase().includes(q)
    );
  });

  async function handleNew() {
    if (creating) return;
    setCreating(true);
    try {
      await onNew();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
        <label className="relative min-w-[8rem] flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-secondary)]"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search prompts…"
            className="ds-input w-full !py-1.5 !pl-8"
            aria-label="Search prompts"
          />
        </label>
        <AgentScopeFilter
          value={agentId}
          onChange={onAgentChange}
          counts={counts}
        />
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm"
          disabled={creating}
          onClick={() => void handleNew()}
        >
          {creating ? "Creating…" : "New"}
        </button>
      </div>

      <div className="border-b border-[var(--line)] px-4 py-2 sm:px-5">
        <FilterChips
          value={statusFilter}
          onChange={onStatusFilter}
          options={[
            { id: "all", label: "All" },
            { id: "live", label: "Live" },
            { id: "shadow", label: "Shadow" },
            { id: "draft", label: "Draft" },
            { id: "archived", label: "Archived" },
          ]}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={q || statusFilter !== "all" ? "No matches" : "No prompts"}
          action={
            q || statusFilter !== "all" ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => {
                  onQueryChange("");
                  onStatusFilter("all");
                }}
              >
                Clear
              </button>
            ) : (
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                disabled={creating}
                onClick={() => void handleNew()}
              >
                {creating ? "Creating…" : "New prompt"}
              </button>
            )
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((p) => {
            const active = p.id === activeId;
            const live = liveVersion(p);
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
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <PromptStatusChip status={p.status} />
                    {live ? (
                      <span className="type-meta text-[var(--text-faint)]">
                        {live.label}
                      </span>
                    ) : null}
                  </div>
                  <span className="type-ui truncate text-[var(--text)]">
                    {p.name}
                  </span>
                  <span className="type-meta truncate">
                    {p.slug} · {agentLabel(p.agentId)}
                    {p.usage24h > 0
                      ? ` · ${p.usage24h}/24h · ${formatFailRate(p.failRate)} fail`
                      : null}
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
