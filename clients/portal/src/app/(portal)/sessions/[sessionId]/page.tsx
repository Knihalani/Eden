"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import {
  CrossLinkBar,
  DetailPanelShell,
  readMasterDetailParam,
  writeMasterDetailParam,
} from "@/components/portal-os";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { SessionHeader } from "@/components/sessions/SessionHeader";
import { SessionTurnTimeline } from "@/components/sessions/SessionTurnTimeline";
import {
  buildSessionTurns,
  type SessionTracePreviewRow,
} from "@/components/sessions/session-turn-preview";
import type { DetailMode } from "@/components/traces/TraceDetailPanel";
import { useOrg } from "@/hooks/use-org";
import { agentSessionsApi } from "@/lib/api";
import { fetchApi } from "@/lib/api/core";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  preserveFromSearchParams,
} from "@/lib/portal-cross-links";

/** Align with hub `DETAIL_MODES` / TraceDetailPanel tabs — transcript default. */
const SESSION_DETAIL_MODES = [
  "transcript",
  "tree",
  "timeline",
  "meta",
  "scores",
] as const satisfies readonly DetailMode[];

/** Trace detail + rrweb replay stay off the session shell first paint (W12). */
const TraceDetailPanel = dynamic(
  () =>
    import("@/components/traces/TraceDetailPanel").then((m) => ({
      default: m.TraceDetailPanel,
    })),
  { ssr: false, loading: () => <LoadingSkeleton variant="detail" lines={4} /> },
);
const BrowserReplayPanel = dynamic(
  () =>
    import("@/components/browser/BrowserReplayPanel").then((m) => ({
      default: m.BrowserReplayPanel,
    })),
  { ssr: false, loading: () => <LoadingSkeleton variant="default" lines={3} /> },
);

function SessionPageInner() {
  const params = useParams();
  const sessionId = decodeURIComponent(String(params.sessionId ?? ""));
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTraceId = readMasterDetailParam(searchParams, "traceId");
  const selectedSpanId = readMasterDetailParam(searchParams, "spanId");
  const modeParam = searchParams.get("mode");
  const linkPreserve = preserveFromSearchParams(searchParams);
  const detailMode: DetailMode =
    modeParam && (SESSION_DETAIL_MODES as readonly string[]).includes(modeParam)
      ? (modeParam as DetailMode)
      : "transcript";
  const [activeReplayStep, setActiveReplayStep] = useState(0);

  const replaceSessionParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams.toString());
    mutate(next);
    const qs = next.toString();
    router.replace(
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      { scroll: false },
    );
  };

  const setSelectedTraceId = (id: string | undefined) => {
    replaceSessionParams((next) => {
      writeMasterDetailParam(next, "traceId", id);
      writeMasterDetailParam(next, "spanId", undefined);
      if (!id) next.delete("mode");
    });
  };

  const handleSelectSpan = (spanId: string | null) => {
    replaceSessionParams((next) => {
      writeMasterDetailParam(next, "spanId", spanId || undefined);
    });
  };

  const handleDetailModeChange = (mode: DetailMode) => {
    replaceSessionParams((next) => {
      if (mode === "transcript") next.delete("mode");
      else next.set("mode", mode);
    });
  };

  const sessionQuery = useOrgQuery(
    queryKeys.agents.session(orgId, sessionId),
    orgId,
    () => agentSessionsApi.get(orgId!, sessionId).then((r) => r.data?.session ?? null),
  );

  const session = sessionQuery.data;

  const tracesQuery = useOrgQuery(
    queryKeys.agents.sessionTraces(
      orgId,
      sessionId,
      session?.trace_ids?.join(",") ?? null,
    ),
    orgId && session?.trace_ids?.length ? orgId : null,
    async () => {
      const ids = (session!.trace_ids ?? []).slice(0, 100);
      if (ids.length === 0) return [] as SessionTracePreviewRow[];
      // K5: one batch request for all session traces (not N× listObservabilityTraces).
      const q = new URLSearchParams();
      for (const tid of ids) q.append("trace_ids", tid);
      q.set("limit", String(Math.min(100, Math.max(ids.length, 1))));
      const res = await fetchApi<{ traces: SessionTracePreviewRow[] }>(
        `/orgs/${orgId}/observability/traces?${q.toString()}`,
      );
      return res.traces ?? [];
    },
  );

  const turns = useMemo(
    () => buildSessionTurns(session?.trace_ids ?? [], tracesQuery.data ?? []),
    [session?.trace_ids, tracesQuery.data],
  );

  useEffect(() => {
    if (!selectedTraceId && turns.length > 0) {
      setSelectedTraceId(turns[0]!.trace_id);
    }
    // Intentionally only when turns first arrive — avoid clobbering user clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSelectedTraceId is stable URL writer
  }, [turns.length, selectedTraceId]);

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
          {
            label: "All traces",
            href: (() => {
              const q = new URLSearchParams();
              q.set("view", "sessions");
              if (linkPreserve?.q) q.set("q", linkPreserve.q);
              if (linkPreserve?.pastHours) q.set("pastHours", linkPreserve.pastHours);
              if (linkPreserve?.realm) q.set("realm", linkPreserve.realm);
              if (linkPreserve?.outcome) q.set("outcome", linkPreserve.outcome);
              if (linkPreserve?.agent_id) q.set("agent_id", linkPreserve.agent_id);
              return `/traces?${q.toString()}`;
            })(),
          },
          { label: "Issues", href: "/issues" },
          ...(session.agent_id
            ? [{ label: "Agent ledger", href: `/agents/${session.agent_id}/ledger` }]
            : []),
        ]}
      />

      <SessionTurnTimeline
        turns={turns}
        selectedTraceId={selectedTraceId}
        layout="rail"
        openTraceView="sessions"
        preserve={{ ...linkPreserve, view: "sessions" }}
        onSelectTurn={(id) => {
          setSelectedTraceId(id);
          const idx = turns.findIndex((t) => t.trace_id === id);
          setActiveReplayStep(Math.max(idx, 0));
        }}
      />

      {selectedTraceId ? (
        <DetailPanelShell
          open
          onClose={() => setSelectedTraceId(undefined)}
          title={
            <span className="font-mono text-xs truncate">
              {selectedTraceId.slice(0, 20)}…
            </span>
          }
          widthClassName="xl:w-full xl:max-w-none"
          mobileDrawer
        >
          <TraceDetailPanel
            traceId={selectedTraceId}
            onClose={() => setSelectedTraceId(undefined)}
            hideCloseControl
            initialMode={detailMode}
            onModeChange={handleDetailModeChange}
            highlightSpanId={selectedSpanId}
            onSpanSelect={handleSelectSpan}
          />
        </DetailPanelShell>
      ) : (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)]">
          <p className="p-6 text-sm text-[var(--text-muted)]">
            Select a turn to view its transcript.
          </p>
        </div>
      )}

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
