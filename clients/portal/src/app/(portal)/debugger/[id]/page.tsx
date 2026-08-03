"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { StickyNote } from "lucide-react";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  agentLabel,
  labDebuggerListHref,
  rememberClientSession,
  sessionById,
  type DebuggerCheckpoint,
  type DebuggerMode,
  type DebuggerSessionFixture,
} from "@/lab/fixtures/debugger";
import {
  DebuggerBackLink,
  DebuggerModeNav,
  parseDebuggerMode,
} from "@/lab/debugger/debugger-chrome";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { debuggerApi } from "@/lib/api/resources";
import { ASSIST_STALE, SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { EmptyState } from "@/lab/lab-ui";
import { catalogTraces } from "@/lib/portal-catalog";

const debuggerFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const DebuggerCompareView = dynamic(
  () =>
    import("@/lab/debugger/debugger-modes").then((m) => ({
      default: m.DebuggerCompareView,
    })),
  { loading: () => debuggerFallback },
);
const DebuggerInspectView = dynamic(
  () =>
    import("@/lab/debugger/debugger-modes").then((m) => ({
      default: m.DebuggerInspectView,
    })),
  { loading: () => debuggerFallback },
);
const DebuggerNotesPanel = dynamic(
  () =>
    import("@/lab/debugger/debugger-modes").then((m) => ({
      default: m.DebuggerNotesPanel,
    })),
  { loading: () => debuggerFallback },
);
const DebuggerReplayView = dynamic(
  () =>
    import("@/lab/debugger/debugger-modes").then((m) => ({
      default: m.DebuggerReplayView,
    })),
  { loading: () => debuggerFallback },
);
const DebuggerTimeTravelView = dynamic(
  () =>
    import("@/lab/debugger/debugger-modes").then((m) => ({
      default: m.DebuggerTimeTravelView,
    })),
  { loading: () => debuggerFallback },
);

function liveTraceList() {
  return catalogTraces();
}

function LabDebuggerDetailInner() {
  const params = useParams<{ id: string }>();
  const sessionId = decodeURIComponent(params.id ?? "");
  const searchParams = useSearchParams();
  const paramMode = searchParams.get("mode");
  const paramLeft = searchParams.get("leftTraceId");
  const paramRight = searchParams.get("rightTraceId");
  const paramSpan = searchParams.get("spanId");
  const paramAgent = searchParams.get("agent");

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const sessionsQuery = useOrgQuery(
    queryKeys.portal.debuggerSessions(orgId),
    orgId,
    () => portalApi.debuggerSessions(orgId!),
    { ...SHELL_QUERY, staleTime: ASSIST_STALE },
  );
  const sessions = sessionsQuery.data ?? [];

  const [sessionPatch, setSessionPatch] = useState<
    Partial<DebuggerSessionFixture>
  >({});
  const [notesOpen, setNotesOpen] = useState(false);

  const baseSession = useMemo(() => {
    return (
      sessions.find((s) => s.id === sessionId) ??
      sessionById(sessionId) ??
      null
    );
  }, [sessions, sessionId]);

  const session = useMemo(() => {
    if (!baseSession) return null;
    return { ...baseSession, ...sessionPatch };
  }, [baseSession, sessionPatch]);

  const mode = parseDebuggerMode(paramMode ?? session?.modeHint ?? "replay");

  const traces = liveTraceList();
  const leftTraceId =
    paramLeft ?? session?.sourceTraceId ?? traces[0]?.id ?? "";
  const rightTraceId =
    paramRight ??
    session?.compareTraceId ??
    traces.find((t) => t.id !== leftTraceId)?.id ??
    leftTraceId;

  const sourceTraceQuery = useOrgQuery(
    queryKeys.portal.traceDetail(orgId, session?.sourceTraceId ?? null),
    orgId,
    ({ signal }) =>
      portalApi.traceDetail(orgId!, session!.sourceTraceId, signal),
    {
      ...SHELL_QUERY,
      staleTime: ASSIST_STALE,
      enabled: Boolean(orgId && session?.sourceTraceId),
    },
  );
  const leftDetailQuery = useOrgQuery(
    queryKeys.portal.traceDetail(orgId, leftTraceId || null),
    orgId,
    ({ signal }) => portalApi.traceDetail(orgId!, leftTraceId, signal),
    {
      ...SHELL_QUERY,
      staleTime: ASSIST_STALE,
      enabled: Boolean(orgId && leftTraceId && mode === "compare"),
    },
  );
  const rightDetailQuery = useOrgQuery(
    queryKeys.portal.traceDetail(orgId, rightTraceId || null),
    orgId,
    ({ signal }) => portalApi.traceDetail(orgId!, rightTraceId, signal),
    {
      ...SHELL_QUERY,
      staleTime: ASSIST_STALE,
      enabled: Boolean(
        orgId && rightTraceId && mode === "compare" && rightTraceId !== leftTraceId,
      ),
    },
  );

  const sourceTrace = sourceTraceQuery.data ?? null;
  const leftTrace =
    leftDetailQuery.data ??
    (leftTraceId === session?.sourceTraceId ? sourceTrace : null);
  const rightTrace =
    rightTraceId === leftTraceId
      ? leftTrace
      : (rightDetailQuery.data ??
        (rightTraceId === session?.sourceTraceId ? sourceTrace : null));

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) setAgentId(paramAgent);
  }, [paramAgent, agentId, setAgentId]);

  // Reset local patches when the route session changes.
  useEffect(() => {
    setSessionPatch({});
    setNotesOpen(false);
  }, [sessionId]);

  const setMode = useCallback(
    (next: DebuggerMode) => {
      patchQuery({ mode: next });
    },
    [patchQuery],
  );

  const updateSession = useCallback(
    (patch: Partial<DebuggerSessionFixture>) => {
      setSessionPatch((prev) => {
        const next = { ...prev, ...patch };
        if (baseSession) {
          rememberClientSession({ ...baseSession, ...next });
        }
        return next;
      });
    },
    [baseSession],
  );

  const onReplay = useCallback(
    async (checkpoint: DebuggerCheckpoint, fromStep: number) => {
      const traceId = session?.sourceTraceId;
      if (!orgId || !traceId) {
        updateSession({
          updatedAt: "just now",
          lastReplay: {
            at: "just now",
            fromCheckpointId: checkpoint.id,
            outcome: "error",
            summary:
              "Hermetic re-run unavailable — missing org or source trace id.",
          },
        });
        return;
      }
      try {
        const result = await debuggerApi.rerun(orgId, {
          trace_id: traceId,
          from_step: Math.max(0, fromStep),
          live_prefix: false,
          session_id: session?.id?.startsWith("dbg_") ? session.id : undefined,
        });
        const diffLen = Array.isArray(result.diff) ? result.diff.length : 0;
        const cpCount = Array.isArray(result.checkpoints)
          ? result.checkpoints.length
          : 0;
        updateSession({
          updatedAt: "just now",
          lastReplay: {
            at: "just now",
            fromCheckpointId: checkpoint.id,
            outcome: cpCount > 0 ? "ok" : "error",
            summary:
              cpCount > 0
                ? `Hermetic re-run from step ${result.from_step} → ${result.to_step} (${cpCount} checkpoints, ${diffLen} diffs). Recorded responses only — no live LLM.`
                : `Hermetic re-run returned no checkpoints for ${traceId}. Ingest debugger checkpoints or open the trace inspect view.`,
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Hermetic re-run failed";
        updateSession({
          updatedAt: "just now",
          lastReplay: {
            at: "just now",
            fromCheckpointId: checkpoint.id,
            outcome: "error",
            summary: message,
          },
        });
      }
    },
    [orgId, session?.id, session?.sourceTraceId, updateSession],
  );

  const related = useMemo(() => {
    if (!session) return null;
    return {
      traces: `/traces?id=${session.sourceTraceId}&agent=${session.agentId}`,
      issues: `/issues?agent=${session.agentId}`,
      improve: `/improve?agent=${session.agentId}`,
      askAi: `/agent?thread=thr_empty&traceId=${session.sourceTraceId}&agent=${session.agentId}&ai_prompt=${encodeURIComponent(
        `Help me debug ${session.title}`,
      )}`,
      agent: `/agents?id=${session.agentId}`,
    };
  }, [session]);

  if (sessionsQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Debugger" />
        <QueryLoadingPanel label="Loading debugger session…" />
      </div>
    );
  }

  if (sessionsQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Debugger" />
        <QueryErrorPanel
          error={sessionsQuery.error}
          onRetry={() => void sessionsQuery.refetch()}
        />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="ds-page">
        <PageHeader title="Debugger" />
        <EmptyState
          title="Session not found"
          body="This session isn’t in the live list — it may have been created only in another tab, or the id is stale."
          action={
            <Link
              href={labDebuggerListHref()}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              All sessions
            </Link>
          }
        />
      </div>
    );
  }

  const hasNotes = Boolean(session.notes.trim());

  return (
    <div className="ds-page">
      <PageHeader
        title={session.title}
        meta={
          <Link
            href={`/agents?id=${session.agentId}`}
            className="ds-btn ds-btn-ghost ds-btn-sm !h-auto !px-2 !py-0.5"
          >
            {agentLabel(session.agentId)}
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DebuggerBackLink href={labDebuggerListHref({ agent: agentId })} />
            <DebuggerModeNav value={mode} onChange={setMode} />
            <button
              type="button"
              className={cn(
                "ds-btn ds-btn-ghost ds-btn-sm",
                notesOpen && "bg-[var(--bg-active)]",
              )}
              aria-pressed={notesOpen}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <StickyNote className="h-3.5 w-3.5" aria-hidden />
              Notes{hasNotes && !notesOpen ? " ·" : ""}
            </button>
            <Link
              href={related!.traces}
              className="ds-btn ds-btn-outline ds-btn-sm"
            >
              Open trace
            </Link>
          </div>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {mode === "replay" ? (
            <DebuggerReplayView
              session={session}
              focusSpanId={paramSpan}
              onFocusSpan={(spanId) => patchQuery({ spanId })}
              onReplay={onReplay}
              sourceTrace={sourceTrace}
              sourceTraceLoading={sourceTraceQuery.isLoading}
              sourceTraceError={
                sourceTraceQuery.isError
                  ? (sourceTraceQuery.error as Error)
                  : null
              }
              onRetrySourceTrace={() => void sourceTraceQuery.refetch()}
              liveTravelNote="Hermetic re-run uses recorded debugger checkpoints only (no live LLM). Use the Time travel tab for Cat 20 fork + live replay."
            />
          ) : null}
          {mode === "compare" ? (
            <DebuggerCompareView
              session={session}
              leftTraceId={leftTraceId}
              rightTraceId={rightTraceId}
              onLeftChange={(id) => patchQuery({ leftTraceId: id })}
              onRightChange={(id) => patchQuery({ rightTraceId: id })}
              leftTrace={leftTrace}
              rightTrace={rightTrace}
              detailsLoading={
                leftDetailQuery.isLoading || rightDetailQuery.isLoading
              }
            />
          ) : null}
          {mode === "inspect" ? (
            <DebuggerInspectView
              session={session}
              focusSpanId={paramSpan}
              onFocusSpan={(spanId) => patchQuery({ spanId })}
              sourceTrace={sourceTrace}
              sourceTraceLoading={sourceTraceQuery.isLoading}
              sourceTraceError={
                sourceTraceQuery.isError
                  ? (sourceTraceQuery.error as Error)
                  : null
              }
              onRetrySourceTrace={() => void sourceTraceQuery.refetch()}
            />
          ) : null}
          {mode === "time-travel" ? (
            <DebuggerTimeTravelView
              session={session}
              orgId={orgId}
              sourceTrace={sourceTrace}
              focusSpanId={paramSpan}
              onFocusSpan={(spanId) => patchQuery({ spanId })}
            />
          ) : null}

          <footer className="shrink-0 border-t border-[var(--line)] px-4 py-2 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="type-meta text-[var(--text-faint)]">Open in</span>
              <Link href={related!.askAi} className="ds-btn ds-btn-ghost ds-btn-sm">
                Ask AI
              </Link>
              <Link href={related!.issues} className="ds-btn ds-btn-ghost ds-btn-sm">
                Issues
              </Link>
              <Link href={related!.improve} className="ds-btn ds-btn-ghost ds-btn-sm">
                Improve
              </Link>
              <Link href={related!.agent} className="ds-btn ds-btn-ghost ds-btn-sm">
                Agent
              </Link>
            </div>
          </footer>
        </div>

        {notesOpen ? (
          <DebuggerNotesPanel
            notes={session.notes}
            onChange={(notes) =>
              updateSession({ notes, updatedAt: "just now" })
            }
            onClose={() => setNotesOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function LabDebuggerDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader
            title="Debugger"
            meta={<span className="type-meta">Loading…</span>}
          />
        </div>
      }
    >
      <LabDebuggerDetailInner />
    </Suspense>
  );
}
