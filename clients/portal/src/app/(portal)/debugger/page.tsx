"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  labDebuggerDetailHref,
  sessionFromTrace,
  type DebuggerSessionFixture,
} from "@/lab/fixtures/debugger";
import { DebuggerListView } from "@/lab/debugger/debugger-list-view";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { ASSIST_STALE, SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { LocalDraftBanner } from "@/components/shell/local-draft-banner";
import { catalogTraces } from "@/lib/portal-catalog";
import { useLabToast } from "@/lab/lab-toast";

function LabDebuggerListInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramTrace = searchParams.get("traceId");
  const paramSpan = searchParams.get("spanId");
  const paramAgent = searchParams.get("agent");
  const paramQ = searchParams.get("q");

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { pushToast } = useLabToast();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const sessionsQuery = useOrgQuery(
    queryKeys.portal.debuggerSessions(orgId),
    orgId,
    () => portalApi.debuggerSessions(orgId!),
    { ...SHELL_QUERY, staleTime: ASSIST_STALE },
  );
  const sessions = sessionsQuery.data ?? [];

  const [localSessions, setLocalSessions] = useState<DebuggerSessionFixture[]>(
    [],
  );
  const [query, setQuery] = useState(paramQ ?? "");
  const seeded = useRef(false);

  const allSessions = useMemo(() => {
    const localIds = new Set(localSessions.map((s) => s.id));
    return [
      ...localSessions,
      ...sessions.filter((s) => !localIds.has(s.id)),
    ];
  }, [localSessions, sessions]);

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) setAgentId(paramAgent);
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    if (paramQ != null) setQuery(paramQ);
  }, [paramQ]);

  /** Seed from ?traceId= → create session and open detail. */
  useEffect(() => {
    if (!paramTrace || seeded.current) return;
    if (sessionsQuery.isLoading) return;
    // Don't mint a client-only session while the list is in error —
    // that races QueryErrorPanel and looks like "API failed but opened".
    if (sessionsQuery.isError) return;
    seeded.current = true;
    const existing = allSessions.find((s) => s.sourceTraceId === paramTrace);
    if (existing) {
      router.replace(
        labDebuggerDetailHref(existing.id, {
          mode: "replay",
          spanId: paramSpan,
          agent: existing.agentId,
        }),
      );
      return;
    }
    const created = sessionFromTrace(paramTrace, {
      spanId: paramSpan ?? undefined,
      agentId: paramAgent ?? undefined,
    });
    setLocalSessions((prev) => [created, ...prev]);
    router.replace(
      labDebuggerDetailHref(created.id, {
        mode: "replay",
        spanId: paramSpan,
        agent: created.agentId,
      }),
    );
  }, [
    paramTrace,
    paramSpan,
    paramAgent,
    router,
    sessionsQuery.isLoading,
    sessionsQuery.isError,
    allSessions,
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
      const s = allSessions.find((x) => x.id === id);
      router.push(
        labDebuggerDetailHref(id, {
          mode: s?.modeHint ?? "replay",
          agent: s?.agentId,
        }),
      );
    },
    [router, allSessions],
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
    const created = sessionFromTrace(seed.id, { agentId: seed.agentId });
    setLocalSessions((prev) => [created, ...prev]);
    router.push(
      labDebuggerDetailHref(created.id, {
        mode: "replay",
        agent: created.agentId,
      }),
    );
  }, [agentId, router, pushToast]);

  const scopedCount = useMemo(
    () =>
      agentId === "all"
        ? allSessions.length
        : allSessions.filter((s) => s.agentId === agentId).length,
    [allSessions, agentId],
  );

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
      {localSessions.length > 0 ? (
        <LocalDraftBanner>
          Sessions started here are client-minted only and are not saved to the
          server yet.
        </LocalDraftBanner>
      ) : null}
      <DebuggerListView
        sessions={allSessions}
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
          <PageHeader title="Debugger" />
        </div>
      }
    >
      <LabDebuggerListInner />
    </Suspense>
  );
}
