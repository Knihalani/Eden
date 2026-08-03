"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  labDebuggerDetailHref,
  type DebuggerSessionFixture,
} from "@/lab/fixtures/debugger";
import { DebuggerListView } from "@/lab/debugger/debugger-list-view";
import { parseDebuggerMode } from "@/lab/debugger/debugger-chrome";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import {
  debugSessionsApi,
  type DebugSessionRecord,
} from "@/lib/api/resources";
import { ASSIST_STALE, SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { catalogTraces } from "@/lib/portal-catalog";
import { useLabToast } from "@/lab/lab-toast";

/** Map debugger API session → portal list fixture shape. */
function sessionToFixture(
  session: DebugSessionRecord,
  fallbacks?: { agentId?: string; sourceTraceId?: string; modeHint?: DebuggerSessionFixture["modeHint"] },
): DebuggerSessionFixture {
  const notes = String(session.notes ?? "");
  let agentId = fallbacks?.agentId ?? "";
  if (notes.startsWith("agent:")) {
    agentId = notes.split(":", 1)[1]?.split(/\s/)[0]?.trim() ?? agentId;
  }
  const runs = Array.isArray(session.runs) ? session.runs : [];
  const last = runs.length > 0 && typeof runs[runs.length - 1] === "object"
    ? (runs[runs.length - 1] as Record<string, unknown>)
    : null;
  const compareId = last?.result_trace_id;
  return {
    id: String(session.id),
    title: String(session.title || "Debug session"),
    agentId,
    sourceTraceId: String(
      session.source_trace_id ?? fallbacks?.sourceTraceId ?? "",
    ),
    compareTraceId: compareId != null ? String(compareId) : undefined,
    updatedAt: String(session.updated_at ?? session.created_at ?? "just now"),
    modeHint: fallbacks?.modeHint ?? (compareId ? "compare" : "replay"),
    notes,
  };
}

function LabDebuggerListInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramTrace = searchParams.get("traceId") ?? searchParams.get("id");
  const paramSpan = searchParams.get("spanId") ?? searchParams.get("span");
  const paramAgent = searchParams.get("agent");
  const paramQ = searchParams.get("q");
  const paramMode =
    searchParams.get("mode") ?? searchParams.get("tab");

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { pushToast } = useLabToast();
  const queryClient = useQueryClient();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const sessionsQuery = useOrgQuery(
    queryKeys.portal.debuggerSessions(orgId),
    orgId,
    () => portalApi.debuggerSessions(orgId!),
    { ...SHELL_QUERY, staleTime: ASSIST_STALE },
  );
  const sessions = sessionsQuery.data ?? [];

  const [query, setQuery] = useState(paramQ ?? "");
  const seeded = useRef(false);
  const creating = useRef(false);

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) setAgentId(paramAgent);
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    if (paramQ != null) setQuery(paramQ);
  }, [paramQ]);

  const createAndOpen = useCallback(
    async (opts: {
      title: string;
      sourceTraceId: string;
      agentId?: string;
      spanId?: string | null;
      mode?: ReturnType<typeof parseDebuggerMode>;
      replace?: boolean;
    }) => {
      if (!orgId || creating.current) return;
      creating.current = true;
      try {
        const notesParts: string[] = [];
        if (opts.agentId) notesParts.push(`agent:${opts.agentId}`);
        if (opts.spanId) notesParts.push(`span:${opts.spanId}`);
        const { session } = await debugSessionsApi.create(orgId, {
          title: opts.title,
          source_trace_id: opts.sourceTraceId,
          notes: notesParts.length > 0 ? notesParts.join(" ") : undefined,
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.debuggerSessions(orgId),
        });
        const fixture = sessionToFixture(session, {
          agentId: opts.agentId,
          sourceTraceId: opts.sourceTraceId,
          modeHint: opts.mode ?? "replay",
        });
        const href = labDebuggerDetailHref(fixture.id, {
          mode: opts.mode ?? "replay",
          spanId: opts.spanId,
          agent: fixture.agentId || undefined,
        });
        if (opts.replace) router.replace(href);
        else router.push(href);
      } catch (err) {
        pushToast({
          title: "Could not create debug session",
          body: err instanceof Error ? err.message : String(err),
          tone: "fail",
        });
        seeded.current = false;
      } finally {
        creating.current = false;
      }
    },
    [orgId, queryClient, router, pushToast],
  );

  /** Seed from ?traceId= → create session and open detail. */
  useEffect(() => {
    if (!paramTrace || seeded.current) return;
    if (!orgId) return;
    if (sessionsQuery.isLoading) return;
    // Don't mint a session while the list is in error —
    // that races QueryErrorPanel and looks like "API failed but opened".
    if (sessionsQuery.isError) return;
    seeded.current = true;
    const existing = sessions.find((s) => s.sourceTraceId === paramTrace);
    const seededMode = parseDebuggerMode(paramMode);
    if (existing) {
      router.replace(
        labDebuggerDetailHref(existing.id, {
          mode: seededMode,
          spanId: paramSpan,
          agent: existing.agentId,
        }),
      );
      return;
    }
    const traces = catalogTraces();
    const seed = traces.find((t) => t.id === paramTrace);
    void createAndOpen({
      title: `Debug · ${seed?.name ?? paramTrace}`,
      sourceTraceId: paramTrace,
      agentId: paramAgent ?? seed?.agentId,
      spanId: paramSpan,
      mode: seededMode,
      replace: true,
    });
  }, [
    paramTrace,
    paramSpan,
    paramAgent,
    paramMode,
    orgId,
    router,
    sessionsQuery.isLoading,
    sessionsQuery.isError,
    sessions,
    createAndOpen,
  ]);

  const onQueryChange = useCallback(
    (v: string) => {
      setQuery(v);
      patchQuery({ q: v.trim() ? v : null });
    },
    [patchQuery],
  );

  const onSelect = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      router.push(
        labDebuggerDetailHref(id, {
          mode: s?.modeHint ?? "replay",
          agent: s?.agentId,
        }),
      );
    },
    [router, sessions],
  );

  const onNew = useCallback(() => {
    const traces = catalogTraces();
    const seed =
      (agentId !== "all"
        ? traces.find((t) => t.agentId === agentId)
        : traces.find((t) => t.severity === "error")) ?? traces[0];
    if (!seed) {
      pushToast({
        title: "No traces yet",
        body: "Ingest a run before opening the debugger.",
        tone: "fail",
      });
      return;
    }
    void createAndOpen({
      title: `Debug · ${seed.name}`,
      sourceTraceId: seed.id,
      agentId: seed.agentId,
      mode: "replay",
    });
  }, [agentId, createAndOpen, pushToast]);

  const scopedCount = useMemo(
    () =>
      agentId === "all"
        ? sessions.length
        : sessions.filter((s) => s.agentId === agentId).length,
    [sessions, agentId],
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Debugger"
        message="Select a workspace to view debugger sessions."
      />
    );
  }

  if (sessionsQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Debugger" />
        <QueryLoadingPanel label="Loading debugger sessions…" />
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

  return (
    <div className="ds-page">
      <PageHeader
        title="Debugger"
        meta={
          <span className="type-meta">
            Replay a single trace step-by-step · pick a run from Traces, or
            start a session here
            {scopedCount > 0 ? ` · ${scopedCount} sessions` : ""}
          </span>
        }
      />
      <DebuggerListView
        sessions={sessions}
        query={query}
        onQueryChange={onQueryChange}
        agentId={agentId}
        onAgentChange={setAgentId}
        onSelect={onSelect}
        onNew={onNew}
      />
    </div>
  );
}

export default function LabDebuggerPage() {
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
      <LabDebuggerListInner />
    </Suspense>
  );
}
