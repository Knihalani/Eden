"use client";

import Link from "next/link";
import { memo, useCallback } from "react";
import {
  agentForSession,
  formatDuration,
  formatTokens,
  formatUsd,
  issuesForSession,
  turnsForSession,
  type SessionFixture,
  type SessionOutcome,
} from "@/lab/fixtures/sessions";
import { SeverityBadge } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

export type HubView = "runs" | "sessions";

export function parseHubView(value: string | null): HubView {
  return value === "sessions" ? "sessions" : "runs";
}

export function SessionOutcomeBadge({
  outcome,
}: {
  outcome: SessionOutcome;
}) {
  if (outcome === "error") return <SeverityBadge severity="error" />;
  if (outcome === "mixed") return <SeverityBadge severity="warn" />;
  return <SeverityBadge severity="none" />;
}

export function HubViewToggle({
  value,
  onChange,
}: {
  value: HubView;
  onChange: (next: HubView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Traces lens"
      className="flex items-center gap-1"
    >
      {(
        [
          ["runs", "Runs"],
          ["sessions", "Sessions"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className="ds-tab"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Memoised sibling of `RunListButton` — same stable-callback contract. */
export const SessionListButton = memo(function SessionListButton({
  session,
  active,
  onSelect,
}: {
  session: SessionFixture;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const agent = agentForSession(session);
  const handleClick = useCallback(
    () => onSelect(session.id),
    [onSelect, session.id],
  );
  return (
    <button
      type="button"
      onClick={handleClick}
      data-session-id={session.id}
      data-active={active ? "true" : "false"}
      data-severity={
        session.outcome === "error"
          ? "error"
          : session.outcome === "mixed"
            ? "warn"
            : "none"
      }
      className="lab-run-row"
    >
      <SessionOutcomeBadge outcome={session.outcome} />
      <div className="min-w-0 flex-1">
        <p className="type-ui truncate text-[var(--text)]">
          {session.diagnosis ?? session.id}
        </p>
        <p className="type-meta mt-1 truncate">
          {agent?.name ?? session.agentId} · {session.turnCount} turn
          {session.turnCount === 1 ? "" : "s"} · {session.startedAt}
        </p>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
        <span className="type-mono tabular-nums !text-[0.6875rem]">
          {formatDuration(session.durationMs)}
        </span>
      </div>
    </button>
  );
});

export function SessionReader({
  session,
  onOpenTurn,
}: {
  session: SessionFixture;
  onOpenTurn: (traceId: string) => void;
}) {
  const agent = agentForSession(session);
  const turns = turnsForSession(session);
  const issues = issuesForSession(session);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <SessionOutcomeBadge outcome={session.outcome} />
              <h2 className="type-ui min-w-0 truncate text-[var(--text)]">
                {session.diagnosis ?? session.id}
              </h2>
            </div>
            <p className="type-meta mt-1.5 truncate">
              {session.id}
              {" · "}
              {agent?.name ?? session.agentId}
              {" · "}
              {session.turnCount} turn{session.turnCount === 1 ? "" : "s"}
              {" · "}
              {session.startedAt}
              {session.endedAt ? ` → ${session.endedAt}` : ""}
            </p>
            <p className="type-mono mt-1.5 tabular-nums !text-[0.6875rem] !text-[var(--text-muted)]">
              {formatDuration(session.durationMs)}
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              {formatTokens(session.totalTokens)}
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              {formatUsd(session.costUsd, 3)}
            </p>
          </div>
          {issues[0] ? (
            <Link
              href={`/issues?id=${issues[0].id}&agent=${issues[0].agentId}`}
              className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
            >
              Open issue
            </Link>
          ) : null}
        </div>
        {session.lastErrorSummary ? (
          <p className="type-body mt-2.5 text-[var(--error)]">
            {session.lastErrorSummary}
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        <h3 className="type-label mb-3">Turns</h3>
        <ul className="space-y-2">
          {turns.map((turn) => {
            const fail =
              turn.trace.severity === "error" || turn.trace.status === "error";
            return (
              <li key={turn.trace.id}>
                <button
                  type="button"
                  onClick={() => onOpenTurn(turn.trace.id)}
                  className={cn(
                    "w-full rounded-[var(--radius)] px-3.5 py-3 text-left transition-colors",
                    "shadow-[0_0_0_1px_var(--line)] hover:bg-[var(--accent-muted)]",
                    fail && "shadow-[0_0_0_1px_var(--error)]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="type-mono tabular-nums !text-[0.6875rem] !text-[var(--text-muted)]">
                      {turn.index}/{turn.of}
                    </span>
                    <SeverityBadge severity={turn.trace.severity} />
                    <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                      {turn.trace.name}
                    </span>
                    <span className="type-mono shrink-0 tabular-nums !text-[0.6875rem]">
                      {formatDuration(turn.trace.durationMs)}
                    </span>
                  </div>
                  {(turn.inputPreview || turn.outputPreview) && (
                    <div className="mt-2 space-y-1">
                      {turn.inputPreview ? (
                        <p className="type-body line-clamp-2">
                          <span className="text-[var(--text-faint)]">in · </span>
                          {turn.inputPreview}
                        </p>
                      ) : null}
                      {turn.outputPreview ? (
                        <p
                          className={cn(
                            "type-body line-clamp-2",
                            fail && "text-[var(--error)]",
                          )}
                        >
                          <span className="text-[var(--text-faint)]">out · </span>
                          {turn.outputPreview}
                        </p>
                      ) : null}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
