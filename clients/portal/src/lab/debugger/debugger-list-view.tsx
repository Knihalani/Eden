"use client";

import Link from "next/link";
import {
  agentLabel,
  modeHintLabel,
  sourceTraceLabel,
  type DebuggerSessionFixture,
} from "@/lab/fixtures/debugger";
import { traceById } from "@/lab/fixtures/traces";
import { DebuggerOutcomeChip } from "@/lab/debugger/debugger-chrome";
import { AgentScopeFilter, EmptyState, SearchInput } from "@/lab/lab-ui";
import { formatSmartTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";

export function DebuggerListView({
  sessions,
  activeId,
  query,
  onQueryChange,
  agentId,
  onAgentChange,
  onSelect,
  onNew,
}: {
  sessions: DebuggerSessionFixture[];
  activeId?: string | null;
  query: string;
  onQueryChange: (v: string) => void;
  agentId: string;
  onAgentChange: (id: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = sessions.filter((s) => {
    if (agentId !== "all" && s.agentId !== agentId) return false;
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      s.sourceTraceId.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      agentLabel(s.agentId).toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder="Search sessions, ids…"
          ariaLabel="Search debugger sessions"
          className="min-w-[12rem] flex-1"
        />
        <AgentScopeFilter value={agentId} onChange={onAgentChange} />
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm"
          onClick={onNew}
        >
          New session
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={q || agentId !== "all" ? "No matches" : "No sessions yet"}
          body={
            q || agentId !== "all"
              ? "Clear filters to see all sessions."
              : U20_EMPTY_COPY.debugger
          }
          action={
            q || agentId !== "all" ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => {
                  onQueryChange("");
                  onAgentChange("all");
                }}
              >
                Clear filters
              </button>
            ) : (
              <Link href="/traces" className="ds-btn ds-btn-primary ds-btn-sm">
                Open traces
              </Link>
            )
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((s) => {
            const active = s.id === activeId;
            const source = traceById(s.sourceTraceId);
            const outcome =
              s.lastReplay?.outcome ??
              (source?.status === "error" ? "error" : "ok");
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "grid w-full cursor-pointer grid-cols-1 gap-1 border-b border-[var(--line)] px-4 py-3 text-left transition-colors sm:grid-cols-[1fr_auto]",
                    active
                      ? "bg-[var(--bg-active)] shadow-[inset_2px_0_0_var(--accent)]"
                      : "hover:bg-[var(--bg-hover)]",
                  )}
                >
                  <div className="min-w-0">
                    <p className="type-ui truncate text-[var(--text)]">
                      {s.title}
                    </p>
                    <p className="type-meta mt-0.5 truncate text-[var(--text-secondary)]">
                      {agentLabel(s.agentId)} ·{" "}
                      {sourceTraceLabel(s.sourceTraceId)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5">
                    <DebuggerOutcomeChip outcome={outcome} />
                    <span className="type-meta text-[var(--text-faint)]">
                      {s.lastReplay
                        ? `Replayed · ${formatSmartTime(s.updatedAt)}`
                        : `${modeHintLabel(s.modeHint)} · ${formatSmartTime(s.updatedAt)}`}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-[var(--line)] px-4 py-2 sm:px-5">
        <p className="type-meta text-[var(--text-faint)]">
          {filtered.length} session{filtered.length === 1 ? "" : "s"}
        </p>
      </div>
    </div>
  );
}
