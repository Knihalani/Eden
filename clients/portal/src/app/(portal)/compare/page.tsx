"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  normalizeAbExperiments,
  seedFromDebuggerSession,
  seedFromEvalsPair,
  type AbExperimentFixture,
  type AbLayout,
  type AbPrimaryMetric,
  type AbSampleGrade,
  type AbStatus,
} from "@/lab/fixtures/compare";
import { isPhantomAbExperiment } from "@/lib/ui-copy";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  parseAbGrade,
  parseAbLayout,
  parseAbMetric,
  parseAbStatusFilter,
} from "@/lab/compare/compare-chrome";
import dynamic from "next/dynamic";
import { patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  LoadingFallback,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";

const compareFallback = <LoadingFallback label="Loading A/B compare…" />;

const CompareListView = dynamic(
  () =>
    import("@/lab/compare/compare-list-view").then((m) => ({
      default: m.CompareListView,
    })),
  { loading: () => compareFallback },
);
const CompareDetailView = dynamic(
  () =>
    import("@/lab/compare/compare-detail-view").then((m) => ({
      default: m.CompareDetailView,
    })),
  { loading: () => compareFallback },
);

function LabCompareInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const paramAgent = searchParams.get("agent");
  const paramLayout = searchParams.get("layout");
  const paramMetric = searchParams.get("metric");
  const paramGrade = searchParams.get("grade");
  const paramSample = searchParams.get("sample");
  const paramDiff = searchParams.get("diff");
  const paramStatus = searchParams.get("status");
  const paramFrom = searchParams.get("from");
  const paramBaselineId = searchParams.get("baselineId");
  const paramCompareId = searchParams.get("compareId");
  const paramDebuggerSession = searchParams.get("debuggerSession");

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    SHELL_QUERY,
  );
  useEffect(() => {
    if (agentsQuery.data === undefined) return;
    patchPortalCatalog({ agents: agentsQuery.data });
  }, [agentsQuery.data]);
  const experimentsQuery = useOrgQuery(
    queryKeys.portal.compareExperiments(orgId),
    orgId,
    () => portalApi.compareExperiments(orgId!),
    SHELL_QUERY,
  );
  const experiments = useMemo(
    () =>
      normalizeAbExperiments(experimentsQuery.data).filter(
        (e) => !isPhantomAbExperiment(e),
      ),
    [experimentsQuery.data],
  );

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const queryClient = useQueryClient();
  const seedAttempted = useRef(false);

  const seeded = useMemo(() => {
    if (paramFrom === "evals") {
      if (!paramBaselineId || !paramCompareId) return undefined;
      const fromList = experiments.find(
        (e) =>
          e.sourceEvalBaselineId === paramBaselineId &&
          e.sourceEvalCompareId === paramCompareId,
      );
      return fromList ?? seedFromEvalsPair(paramBaselineId, paramCompareId);
    }
    if (paramFrom === "debugger") {
      if (!paramDebuggerSession) return undefined;
      const fromList = experiments.find(
        (e) => e.sourceDebuggerSessionId === paramDebuggerSession,
      );
      return (
        fromList ?? seedFromDebuggerSession(paramDebuggerSession)
      );
    }
    return undefined;
  }, [
    paramFrom,
    paramBaselineId,
    paramCompareId,
    paramDebuggerSession,
    experiments,
  ]);

  const [experimentId, setExperimentId] = useState("");
  const [layout, setLayout] = useState<AbLayout>(() =>
    parseAbLayout(paramLayout),
  );
  const [metric, setMetric] = useState<AbPrimaryMetric>(() =>
    parseAbMetric(paramMetric),
  );
  const [gradeFilter, setGradeFilter] = useState<AbSampleGrade | "all">(() =>
    parseAbGrade(paramGrade),
  );
  const [sampleId, setSampleId] = useState<string | null>(
    () => paramSample,
  );
  const [diff, setDiff] = useState(() => paramDiff === "1");
  const [statusFilter, setStatusFilter] = useState<AbStatus | "all">(() =>
    parseAbStatusFilter(paramStatus),
  );
  const [query, setQuery] = useState("");
  const [seedNote, setSeedNote] = useState<string | null>(null);

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    if (paramFrom !== "evals" && paramFrom !== "debugger") return;
    if (experimentsQuery.isLoading) return;
    if (seeded) {
      setSeedNote(paramFrom === "evals" ? "From Evals" : "From Debugger");
      return;
    }

    const canSeedEvals =
      paramFrom === "evals" && Boolean(paramBaselineId) && Boolean(paramCompareId);
    const canSeedDebugger =
      paramFrom === "debugger" && Boolean(paramDebuggerSession);
    if (!canSeedEvals && !canSeedDebugger) {
      setSeedNote("No matching experiment to seed from");
      return;
    }
    if (!orgId || seedAttempted.current) return;
    seedAttempted.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const card = await portalApi.seedCompareExperiment(
          orgId,
          paramFrom === "evals"
            ? {
                from: "evals",
                baselineId: paramBaselineId ?? undefined,
                compareId: paramCompareId ?? undefined,
                agentId: paramAgent ?? undefined,
              }
            : {
                from: "debugger",
                debuggerSession: paramDebuggerSession ?? undefined,
                agentId: paramAgent ?? undefined,
              },
        );
        if (cancelled) {
          seedAttempted.current = false;
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.compareExperiments(orgId),
        });
        setSeedNote(paramFrom === "evals" ? "From Evals" : "From Debugger");
        patchQuery({
          id: card.id,
          from: null,
          baselineId: null,
          compareId: null,
          debuggerSession: null,
        });
      } catch {
        if (cancelled) {
          seedAttempted.current = false;
          return;
        }
        setSeedNote("No matching experiment to seed from");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    paramFrom,
    paramBaselineId,
    paramCompareId,
    paramDebuggerSession,
    paramAgent,
    seeded,
    experimentsQuery.isLoading,
    orgId,
    queryClient,
    patchQuery,
  ]);

  useEffect(() => {
    setLayout(parseAbLayout(paramLayout));
    setMetric(parseAbMetric(paramMetric));
    setGradeFilter(parseAbGrade(paramGrade));
    setSampleId(paramSample);
    setDiff(paramDiff === "1");
    setStatusFilter(parseAbStatusFilter(paramStatus));
  }, [
    paramLayout,
    paramMetric,
    paramGrade,
    paramSample,
    paramDiff,
    paramStatus,
  ]);

  const scoped = useMemo(() => {
    if (agentId === "all") return experiments;
    return experiments.filter((e) => e.agentId === agentId);
  }, [experiments, agentId]);

  // Keep selection inside agent scope / live list.
  useEffect(() => {
    const next =
      scoped.find((e) => e.id === paramId)?.id ??
      seeded?.id ??
      scoped[0]?.id ??
      "";
    if (next && next !== experimentId) setExperimentId(next);
    else if (!next && experimentId) setExperimentId("");
     
  }, [paramId, scoped, seeded]);

  // Resolve seed once into id= and drop seed params.
  useEffect(() => {
    if (!seeded) return;
    if (paramId === seeded.id) return;
    patchQuery({
      id: seeded.id,
      from: null,
      baselineId: null,
      compareId: null,
      debuggerSession: null,
    });
  }, [seeded, paramId, patchQuery]);

  const experiment: AbExperimentFixture | null =
    scoped.find((e) => e.id === experimentId) ?? scoped[0] ?? null;

  const scopeCounts = useMemo(() => {
    const agents = agentsQuery.data ?? [];
    const map: Record<string, number> = {
      all: agents.length,
    };
    for (const a of agents) {
      map[a.id] = 1;
    }
    return map;
  }, [agentsQuery.data]);

  const selectExperiment = useCallback(
    (id: string) => {
      setExperimentId(id);
      setSampleId(null);
      patchQuery({ id, sample: null });
    },
    [patchQuery],
  );

  const changeLayout = useCallback(
    (next: AbLayout) => {
      setLayout(next);
      patchQuery({
        layout: next === "overview" ? null : next,
        ...(next !== "samples" ? { grade: null, diff: null } : {}),
      });
    },
    [patchQuery],
  );

  const changeMetric = useCallback(
    (next: AbPrimaryMetric) => {
      setMetric(next);
      patchQuery({ metric: next === "stumble" ? null : next });
    },
    [patchQuery],
  );

  const changeGrade = useCallback(
    (next: AbSampleGrade | "all") => {
      setGradeFilter(next);
      patchQuery({ grade: next === "all" ? null : next });
    },
    [patchQuery],
  );

  const changeDiff = useCallback(
    (next: boolean) => {
      setDiff(next);
      patchQuery({ diff: next ? "1" : null });
    },
    [patchQuery],
  );

  const changeSample = useCallback(
    (id: string | null) => {
      setSampleId(id);
      patchQuery({ sample: id });
    },
    [patchQuery],
  );

  const changeStatus = useCallback(
    (next: AbStatus | "all") => {
      setStatusFilter(next);
      patchQuery({ status: next === "all" ? null : next });
    },
    [patchQuery],
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Live A/B"
        message="Select a workspace to compare experiments."
      />
    );
  }

  if (experimentsQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Live A/B" />
        <QueryLoadingPanel label="Loading A/B experiments…" />
      </div>
    );
  }

  if (experimentsQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Live A/B" />
        <QueryErrorPanel
          error={experimentsQuery.error}
          onRetry={() => void experimentsQuery.refetch()}
        />
      </div>
    );
  }

  const meta = (
    <span className="type-meta">
      {scoped.length} split{scoped.length === 1 ? "" : "s"}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader title="Live A/B" meta={meta} />
      {seedNote ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--accent-muted)] px-4 py-2 sm:px-5">
          <p className="type-meta text-[var(--text)]">{seedNote}</p>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => setSeedNote(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[22rem] lg:shrink-0 lg:border-b-0 lg:border-r">
          <CompareListView
            experiments={scoped}
            activeId={experiment?.id ?? null}
            query={query}
            onQueryChange={setQuery}
            agentId={agentId}
            onAgentChange={setAgentId}
            statusFilter={statusFilter}
            onStatusFilter={changeStatus}
            onSelect={selectExperiment}
            counts={scopeCounts}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <CompareDetailView
            experiment={experiment}
            layout={layout}
            metric={metric}
            gradeFilter={gradeFilter}
            diff={diff}
            sampleId={sampleId}
            onLayout={changeLayout}
            onMetric={changeMetric}
            onGrade={changeGrade}
            onDiff={changeDiff}
            onSample={changeSample}
          />
        </div>
      </div>
    </div>
  );
}

export default function LabComparePage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading A/B compare…</p>
        </div>
      }
    >
      <LabCompareInner />
    </Suspense>
  );
}
