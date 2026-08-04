"use client";

import Link from "next/link";
import { memo, useCallback, useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  sessionsApi,
  type SessionTurn as ApiSessionTurn,
} from "@/lib/api/resources";
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

function turnSeverity(turn: ApiSessionTurn): "error" | "warn" | "none" {
  if (turn.outcome === "error" || turn.error_type) return "error";
  if (turn.had_stumble) return "warn";
  return "none";
}

function turnTokens(turn: ApiSessionTurn): number {
  return (turn.input_tokens ?? 0) + (turn.output_tokens ?? 0);
}

/** A single real-timeline turn (N12) — cost / duration / stumbles / issues. */
const TurnCard = memo(function TurnCard({
  turn,
  count,
  onOpenTurn,
}: {
  turn: ApiSessionTurn;
  count: number;
  onOpenTurn: (traceId: string) => void;
}) {
  const sev = turnSeverity(turn);
  const fail = sev === "error";
  return (
    <div
      data-turn-index={turn.index}
      className={cn(
        "w-full rounded-[var(--radius)] px-3.5 py-3 text-left",
        "shadow-[0_0_0_1px_var(--line)]",
        fail && "shadow-[0_0_0_1px_var(--error)]",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="type-mono tabular-nums !text-[0.6875rem] !text-[var(--text-muted)]">
          {turn.index}/{count}
        </span>
        <SeverityBadge severity={sev} />
        <button
          type="button"
          onClick={() => onOpenTurn(turn.trace_id)}
          className="type-mono min-w-0 flex-1 truncate text-left !text-[0.6875rem] hover:text-[var(--text)]"
          title="Open trace"
        >
          {turn.trace_id}
        </button>
        <span className="type-mono shrink-0 tabular-nums !text-[0.6875rem]">
          {formatDuration(turn.duration_ms ?? 0)}
        </span>
      </div>
      <p className="type-mono mt-1.5 tabular-nums !text-[0.6875rem] !text-[var(--text-muted)]">
        {formatUsd(turn.cost_usd, 4)}
        <span className="mx-1.5 text-[var(--text-faint)]">·</span>
        {formatTokens(turnTokens(turn))}
        {turn.outcome ? (
          <>
            <span className="mx-1.5 text-[var(--text-faint)]">·</span>
            {turn.outcome}
          </>
        ) : null}
      </p>
      {turn.stumble_kinds.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {turn.stumble_kinds.map((kind) => (
            <span
              key={kind}
              className="type-meta rounded-full bg-[var(--accent-muted)] px-2 py-0.5 text-[var(--warn,var(--text-muted))] shadow-[0_0_0_1px_var(--line)]"
            >
              {kind}
            </span>
          ))}
        </div>
      ) : null}
      {turn.issues.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {turn.issues.map((issue) => (
            <Link
              key={issue.issue_id}
              href={`/issues?id=${encodeURIComponent(issue.issue_id)}`}
              className="type-meta rounded-full px-2 py-0.5 text-[var(--text-muted)] shadow-[0_0_0_1px_var(--line)] hover:text-[var(--text)]"
              title={`${issue.severity} · ${issue.status}`}
            >
              {issue.title || issue.issue_id}
            </Link>
          ))}
        </div>
      ) : null}
      {turn.summary ? (
        <p className={cn("type-body mt-2 line-clamp-2", fail && "text-[var(--error)]")}>
          {turn.summary}
        </p>
      ) : null}
    </div>
  );
});

/**
 * Turns section for a session. Fetches the real ordered timeline
 * (`GET /orgs/{org}/sessions/{id}/timeline`, N12) and renders TurnCard
 * rows; while loading (or when the live API returns nothing / errors)
 * it falls back to the fixture-derived turns so the panel is never
 * worse than before. Also hosts the link-issue action.
 */
export function SessionTurnsSection({
  session,
  fallbackTurns,
  onOpenTurn,
}: {
  session: SessionFixture;
  fallbackTurns: ReturnType<typeof turnsForSession>;
  onOpenTurn: (traceId: string) => void;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const timelineKey = useMemo(
    () => ["portal", "sessionTimeline", orgId, session.id] as const,
    [orgId, session.id],
  );
  const timelineQuery = useOrgQuery(
    timelineKey,
    orgId,
    () => sessionsApi.timeline(orgId!, session.id),
  );
  const apiTurns = timelineQuery.data?.turns ?? [];

  const [issueId, setIssueId] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  const handleLink = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const id = issueId.trim();
      if (!orgId || !id) return;
      setLinking(true);
      setLinkMsg(null);
      try {
        await sessionsApi.linkIssue(orgId, session.id, id);
        setIssueId("");
        setLinkMsg(`Linked ${id}`);
        await queryClient.invalidateQueries({ queryKey: timelineKey });
      } catch (err) {
        setLinkMsg(err instanceof Error ? err.message : "Couldn't link issue");
      } finally {
        setLinking(false);
      }
    },
    [issueId, orgId, session.id, queryClient, timelineKey],
  );

  const useApi = apiTurns.length > 0;
  const count = useApi ? apiTurns.length : fallbackTurns.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="type-label">Turns</h3>
        {orgId ? (
          <form onSubmit={handleLink} className="flex items-center gap-2">
            <input
              value={issueId}
              onChange={(e) => setIssueId(e.target.value)}
              placeholder="Link issue id…"
              aria-label="Issue id to link"
              className="ds-input h-8 w-40 !text-[0.75rem]"
            />
            <button
              type="submit"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={linking || !issueId.trim()}
            >
              {linking ? "Linking…" : "Link"}
            </button>
          </form>
        ) : null}
      </div>
      {linkMsg ? (
        <p className="type-meta mb-3 text-[var(--text-muted)]" role="status">
          {linkMsg}
        </p>
      ) : null}
      {timelineQuery.isError && apiTurns.length === 0 ? (
        <p className="type-meta mb-3 text-[var(--text-faint)]">
          Live timeline unavailable — showing cached turns.
        </p>
      ) : null}
      {useApi ? (
        <ul className="space-y-2" aria-label="Session turns">
          {apiTurns.map((turn) => (
            <li key={`${turn.trace_id}-${turn.index}`}>
              <TurnCard turn={turn} count={count} onOpenTurn={onOpenTurn} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2" aria-label="Session turns">
          {fallbackTurns.map((turn) => {
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
      )}
    </div>
  );
}

export function SessionReader({
  session,
  onOpenTurn,
  onBackToList,
}: {
  session: SessionFixture;
  onOpenTurn: (traceId: string) => void;
  onBackToList?: () => void;
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
              {onBackToList ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-icon lg:hidden"
                  onClick={onBackToList}
                  aria-label="Back to feed"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              ) : null}
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

      <SessionTurnsSection
        session={session}
        fallbackTurns={turns}
        onOpenTurn={onOpenTurn}
      />
    </div>
  );
}
