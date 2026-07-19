"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { CrossLinkBar } from "@/components/portal-os";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { SessionHeader } from "@/components/sessions/SessionHeader";
import { SessionTurnTimeline } from "@/components/sessions/SessionTurnTimeline";
import { TraceDetailPanel } from "@/components/traces/TraceDetailPanel";
import { BrowserReplayPanel } from "@/components/browser/BrowserReplayPanel";
import { useOrg } from "@/hooks/use-org";
import { agentSessionsApi, api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";

function SessionPageInner() {
  const params = useParams();
  const sessionId = decodeURIComponent(String(params.sessionId ?? ""));
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>();
  const [activeReplayStep, setActiveReplayStep] = useState(0);

  const sessionQuery = useOrgQuery(
    queryKeys.agents.session(orgId, sessionId),
    orgId,
    () => agentSessionsApi.get(orgId!, sessionId).then((r) => r.data?.session ?? null),
  );

  const session = sessionQuery.data;

  const tracesQuery = useOrgQuery(
    ["session-traces", orgId, sessionId, session?.trace_ids?.join(",")],
    orgId && session?.trace_ids?.length ? orgId : null,
    async () => {
      const ids = session!.trace_ids ?? [];
      const results = await Promise.all(
        ids.map((tid) =>
          api
            .listObservabilityTraces(orgId!, { trace_id: tid, limit: 1 })
            .then((res) => res.traces?.[0] ?? null)
            .catch(() => null),
        ),
      );
      return results.filter((t): t is NonNullable<typeof t> => t != null);
    },
  );

  const turns = useMemo(() => {
    const traces = tracesQuery.data ?? [];
    const byId = new Map(traces.map((t) => [t.trace_id, t]));
    const ordered = (session?.trace_ids ?? []).map((tid, i) => {
      const t = byId.get(tid);
      return {
        trace_id: tid,
        summary: t?.realm ? `${t.realm} run` : undefined,
        duration_ms: t?.duration_ms,
        cost_cents: t?.cost_cents,
        outcome: t?.outcome,
        had_stumble: t?.outcome === "failure" || t?.outcome === "crash",
        sort_index: i,
      };
    });
    return ordered;
  }, [session?.trace_ids, tracesQuery.data]);

  useEffect(() => {
    if (!selectedTraceId && turns.length > 0) {
      setSelectedTraceId(turns[0].trace_id);
    }
  }, [turns, selectedTraceId]);

  const traceSummaries = useMemo(
    () =>
      turns.map((t) => ({
        trace_id: t.trace_id,
        duration_ms: t.duration_ms,
        cost_cents: t.cost_cents,
        outcome: t.outcome,
      })),
    [turns],
  );

  if (!currentOrg) return <NoOrgState feature="Sessions" />;

  if (sessionQuery.isLoading) {
    return <LoadingSkeleton variant="detail" lines={4} />;
  }

  if (sessionQuery.error || !session) {
    return (
      <PageContent>
        <ErrorState
          title="Session not found"
          message={sessionQuery.error?.message ?? `No session ${sessionId}`}
        />
      </PageContent>
    );
  }

  return (
    <PageContent size="wide" className="space-y-6">
      <PageHeader
        eyebrow="Observe"
        title="Session"
        subtitle="Multi-turn conversation timeline"
      />

      <SessionHeader session={session} traceSummaries={traceSummaries} />

      <CrossLinkBar
        links={[
          { label: "All traces", href: "/traces?view=sessions" },
          { label: "Issues", href: "/issues" },
          ...(session.agent_id
            ? [{ label: "Agent ledger", href: `/agents/${session.agent_id}/ledger` }]
            : []),
        ]}
      />

      <SessionTurnTimeline
        turns={turns}
        selectedTraceId={selectedTraceId}
        onSelectTurn={(id) => {
          setSelectedTraceId(id);
          const idx = turns.findIndex((t) => t.trace_id === id);
          setActiveReplayStep(Math.max(idx, 0));
        }}
      />

      <div className="flex flex-col lg:flex-row gap-0 min-h-[24rem] border border-[var(--border-default)] rounded-xl overflow-hidden">
        <div className="flex-1 min-w-0 lg:border-r border-[var(--border-default)]">
          {selectedTraceId ? (
            <TraceDetailPanel
              traceId={selectedTraceId}
              onClose={() => setSelectedTraceId(undefined)}
            />
          ) : (
            <p className="p-6 text-sm text-[var(--text-muted)]">
              Select a turn to view its transcript.
            </p>
          )}
        </div>
      </div>

      {selectedTraceId && orgId ? (
        <BrowserReplayPanel
          orgId={orgId}
          traceId={selectedTraceId}
          activeStep={activeReplayStep}
        />
      ) : null}
    </PageContent>
  );
}

export default function SessionPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="detail" lines={4} />}>
      <SessionPageInner />
    </Suspense>
  );
}
