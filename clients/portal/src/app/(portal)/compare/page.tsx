"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  seedFromDebuggerSession,
  seedFromEvalsPair,
  type AbExperimentFixture,
  type AbLayout,
  type AbPrimaryMetric,
  type AbSampleGrade,
  type AbStatus,
} from "@/lab/fixtures/compare";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  parseAbGrade,
  parseAbLayout,
  parseAbMetric,
  parseAbStatusFilter,
} from "@/lab/compare/compare-chrome";
import dynamic from "next/dynamic";
import { catalogAgents } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";

const compareFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

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
  const experimentsQuery = useOrgQuery(
    queryKeys.portal.compareExperiments(orgId),
    orgId,
    () => portalApi.compareExperiments(orgId!),
  );
  const experiments = experimentsQuery.data ?? [];

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const seeded = useMemo(() => {
    if (paramFrom === "evals") {
      return seedFromEvalsPair(paramBaselineId, paramCompareId);
    }
    if (paramFrom === "debugger") {
      return seedFromDebuggerSession(paramDebuggerSession);
    }
    return undefined;
  }, [
    paramFrom,
    paramBaselineId,
    paramCompareId,
    paramDebuggerSession,
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
  const [seedNote, setSeedNote] = useState<string | null>(() => {
    if (paramFrom === "evals") {
      return "From Evals";
    }
    if (paramFrom === "debugger") {
      return "From Debugger";
    }
    return null;
  });

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    if (paramFrom === "evals") {
      setSeedNote("From Evals");
    } else if (paramFrom === "debugger") {
      setSeedNote("From Debugger");
    }
  }, [paramFrom]);

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
    const map: Record<string, number> = {
      all: experiments.length,
    };
    for (const a of catalogAgents()) {
      map[a.id] = experiments.filter((e) => e.agentId === a.id).length;
    }
    return map;
  }, [experiments]);

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
