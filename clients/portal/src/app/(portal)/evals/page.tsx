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
import {
  DATASET_CASES,
  caseForIssue,
  caseForTrace,
  casesForDataset,
  comparePairForDataset,
  comparePairForExperiment,
  datasetById,
  datasetForIssue,
  datasetForTrace,
  defaultComparePair,
  defaultDatasetId,
  defaultPlaygroundId,
  draftCaseFromSource,
  experimentsForDataset,
  matrixForPlayground,
  playgroundById,
  type CompareGrade,
  type DatasetCaseFixture,
  type DatasetFixture,
  type ExperimentCaseResult,
  type ExperimentFixture,
  type PlaygroundFixture,
} from "@/lab/fixtures/evals";
import { issueById } from "@/lab/fixtures/issues";
import { traceById } from "@/lab/fixtures/traces";
import { catalogTraces } from "@/lib/portal-catalog";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  EvalsModeNav,
  parseEvalsMode,
  type EvalsMode,
} from "@/lab/evals/evals-chrome";
import dynamic from "next/dynamic";
import type { CompareLayout } from "@/lab/evals/evals-compare-view";
import { catalogAgents, patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";

const viewFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const EvalsCompareView = dynamic(
  () =>
    import("@/lab/evals/evals-compare-view").then((m) => ({
      default: m.EvalsCompareView,
    })),
  { loading: () => viewFallback },
);
const EvalsDatasetsView = dynamic(
  () =>
    import("@/lab/evals/evals-datasets-view").then((m) => ({
      default: m.EvalsDatasetsView,
    })),
  { loading: () => viewFallback },
);
const EvalsPlaygroundView = dynamic(
  () =>
    import("@/lab/evals/evals-playground-view").then((m) => ({
      default: m.EvalsPlaygroundView,
    })),
  { loading: () => viewFallback },
);

function parseLayout(v: string | null): CompareLayout {
  if (v === "summary" || v === "list" || v === "grid") return v;
  return "summary";
}

function parseGrade(v: string | null): CompareGrade | "all" {
  if (
    v === "improve" ||
    v === "regress" ||
    v === "tradeoff" ||
    v === "tie"
  ) {
    return v;
  }
  return "all";
}

function cloneDatasetIntoExtras(
  dsId: string,
  prev: DatasetFixture[],
  liveDatasets: DatasetFixture[],
): DatasetFixture[] {
  if (prev.some((d) => d.id === dsId)) return prev;
  const base =
    liveDatasets.find((d) => d.id === dsId) ?? datasetById(dsId);
  if (!base) return prev;
  return [{ ...base }, ...prev];
}

function LabEvalsInner() {
  const searchParams = useSearchParams();
  const paramMode = searchParams.get("mode");
  const paramTab = searchParams.get("tab");
  const paramId = searchParams.get("id");
  const paramFrom = searchParams.get("from");
  const paramAgent = searchParams.get("agent");
  const paramBaseline = searchParams.get("baselineId");
  const paramCompare = searchParams.get("compareId");
  const paramLayout = searchParams.get("layout");
  const paramGrade = searchParams.get("grade");
  const paramDiff = searchParams.get("diff");
  const paramCase = searchParams.get("case");

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
  const datasetsQuery = useOrgQuery(
    queryKeys.portal.evalDatasets(orgId),
    orgId,
    () => portalApi.evalDatasets(orgId!),
    SHELL_QUERY,
  );
  const playgroundsQuery = useOrgQuery(
    queryKeys.portal.evalPlaygrounds(orgId),
    orgId,
    () => portalApi.evalPlaygrounds(orgId!),
    SHELL_QUERY,
  );
  const experimentsQuery = useOrgQuery(
    queryKeys.portal.evalExperiments(orgId),
    orgId,
    () => portalApi.evalExperiments(orgId!),
    SHELL_QUERY,
  );
  const liveDatasets = datasetsQuery.data ?? [];
  const livePlaygrounds = playgroundsQuery.data ?? [];
  const liveExperiments = experimentsQuery.data ?? [];

  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const defaults = useMemo(
    () => defaultComparePair(liveExperiments),
    [liveExperiments],
  );

  const [mode, setMode] = useState<EvalsMode>(() =>
    parseEvalsMode(paramTab, paramMode),
  );
  const [datasetId, setDatasetId] = useState("");
  const [playgroundId, setPlaygroundId] = useState("");
  const [baselineId, setBaselineId] = useState(
    () => paramBaseline ?? "",
  );
  const [compareId, setCompareId] = useState(
    () => paramCompare ?? "",
  );
  const [layout, setLayout] = useState<CompareLayout>(() =>
    parseLayout(paramLayout),
  );
  const [gradeFilter, setGradeFilter] = useState<CompareGrade | "all">(() =>
    parseGrade(paramGrade),
  );
  const [diff, setDiff] = useState(() => paramDiff === "1");
  const [focusCaseId, setFocusCaseId] = useState<string | null>(paramCase);
  const [dockCaseId, setDockCaseId] = useState<string | null>(null);
  const [fromHint, setFromHint] = useState<string | null>(null);
  // No backend endpoints yet for dataset/case CRUD, experiment runs, or
  // playground create/rename/link/promote — every mutation below
  // (createDataset, renameDataset, deleteDataset, addCase, updateCase,
  // deleteCase, createPlayground, renamePlayground, linkPlaygroundDataset,
  // runExperiment, promotePlayground) only ever touches this local React
  // state. None of it is sent to the API, so it is silently lost on
  // refresh/navigation. `hasUnsavedEvalsWork` below drives a visible
  // banner warning the user about this; do not remove that banner
  // without wiring real persistence for these actions first.
  const [extraDatasets, setExtraDatasets] = useState<DatasetFixture[]>([]);
  const [hiddenDatasetIds, setHiddenDatasetIds] = useState<string[]>([]);
  const [extraCases, setExtraCases] = useState<DatasetCaseFixture[]>([]);
  const [extraExperiments, setExtraExperiments] = useState<
    ExperimentFixture[]
  >([]);
  const [extraResults, setExtraResults] = useState<ExperimentCaseResult[]>(
    [],
  );
  const [extraPlaygrounds, setExtraPlaygrounds] = useState<
    PlaygroundFixture[]
  >([]);
  const [renamingDatasetId, setRenamingDatasetId] = useState<string | null>(
    null,
  );
  const handledFrom = useRef<string | null>(null);

  const allDatasets = useMemo(() => {
    const hidden = new Set(hiddenDatasetIds);
    const extraIds = new Set(extraDatasets.map((d) => d.id));
    return [
      ...extraDatasets.filter((d) => !hidden.has(d.id)),
      ...liveDatasets.filter((d) => !extraIds.has(d.id) && !hidden.has(d.id)),
    ];
  }, [extraDatasets, hiddenDatasetIds, liveDatasets]);

  const allPlaygrounds = useMemo(() => {
    const extraIds = new Set(extraPlaygrounds.map((p) => p.id));
    return [
      ...extraPlaygrounds,
      ...livePlaygrounds.filter((p) => !extraIds.has(p.id)),
    ];
  }, [extraPlaygrounds, livePlaygrounds]);

  const allExperiments = useMemo(() => {
    const extraIds = new Set(extraExperiments.map((e) => e.id));
    return [
      ...extraExperiments,
      ...liveExperiments.filter((e) => !extraIds.has(e.id)),
    ];
  }, [extraExperiments, liveExperiments]);

  const casesFor = useCallback(
    (dsId: string) => {
      const local = extraCases.filter((c) => c.datasetId === dsId);
      const fixture = casesForDataset(dsId).filter(
        (c) => !local.some((l) => l.id === c.id),
      );
      const ds = allDatasets.find((d) => d.id === dsId);
      const known = [...local, ...fixture];
      const missing = (ds?.caseIds ?? []).filter(
        (id) => !known.some((c) => c.id === id),
      );
      return [
        ...known,
        ...missing.map((id, i) => ({
          id,
          datasetId: dsId,
          input: `Case ${known.length + i + 1}`,
          tags: ["manual"] as string[],
        })),
      ];
    },
    [extraCases, allDatasets],
  );

  const createDataset = useCallback(() => {
    const id = `ds_local_${Date.now().toString(36)}`;
    const draft: DatasetFixture = {
      id,
      name: "Untitled dataset",
      description: "",
      agentId: agentId === "all" ? null : agentId,
      source: "manual",
      version: "v1",
      updatedAt: "just now",
      caseIds: [],
    };
    setExtraDatasets((prev) => [draft, ...prev]);
    setDatasetId(id);
    setRenamingDatasetId(id);
    setMode("datasets");
    patchQuery({ mode: "datasets", id, from: null });
  }, [agentId, patchQuery]);

  const renameDataset = useCallback(
    (id: string, name: string) => {
      setExtraDatasets((prev) => {
        const next = cloneDatasetIntoExtras(id, prev, liveDatasets);
        return next.map((d) =>
          d.id === id ? { ...d, name, updatedAt: "just now" } : d,
        );
      });
      setRenamingDatasetId(null);
    },
    [liveDatasets],
  );

  const deleteDataset = useCallback(
    (id: string) => {
      setExtraDatasets((prev) => prev.filter((d) => d.id !== id));
      setHiddenDatasetIds((prev) =>
        prev.includes(id) ? prev : [...prev, id],
      );
      setExtraCases((prev) => prev.filter((c) => c.datasetId !== id));
      const remaining = allDatasets.filter((d) => d.id !== id);
      const nextId = remaining[0]?.id ?? "";
      setDatasetId(nextId);
      if (nextId) patchQuery({ mode: "datasets", id: nextId, from: null });
      else patchQuery({ mode: "datasets", id: null, from: null });
    },
    [allDatasets, patchQuery],
  );

  const addCase = useCallback(
    (dsId: string) => {
      const caseId = `case_local_${Date.now().toString(36)}`;
      const draft: DatasetCaseFixture = {
        id: caseId,
        datasetId: dsId,
        input: "",
        tags: ["manual"],
      };
      setExtraCases((prev) => [draft, ...prev]);
      setExtraDatasets((prev) => {
        const next = cloneDatasetIntoExtras(dsId, prev, liveDatasets);
        return next.map((d) =>
          d.id === dsId
            ? {
                ...d,
                caseIds: [...d.caseIds, caseId],
                updatedAt: "just now",
              }
            : d,
        );
      });
      setDockCaseId(caseId);
    },
    [liveDatasets],
  );

  const updateCase = useCallback(
    (caseId: string, patch: { input?: string; expected?: string }) => {
      setExtraCases((prev) => {
        const hit = prev.find((c) => c.id === caseId);
        if (hit) {
          return prev.map((c) => (c.id === caseId ? { ...c, ...patch } : c));
        }
        const fixture =
          DATASET_CASES.find((c) => c.id === caseId) ??
          casesFor(
            allDatasets.find((d) => d.caseIds.includes(caseId))?.id ?? "",
          ).find((c) => c.id === caseId);
        if (!fixture) return prev;
        return [{ ...fixture, ...patch }, ...prev];
      });
    },
    [allDatasets, casesFor],
  );

  const deleteCase = useCallback(
    (dsId: string, caseId: string) => {
      setExtraCases((prev) => prev.filter((c) => c.id !== caseId));
      setExtraDatasets((prev) => {
        const next = cloneDatasetIntoExtras(dsId, prev, liveDatasets);
        return next.map((d) =>
          d.id === dsId
            ? {
                ...d,
                caseIds: d.caseIds.filter((id) => id !== caseId),
                updatedAt: "just now",
              }
            : d,
        );
      });
      setDockCaseId((cur) => (cur === caseId ? null : cur));
    },
    [liveDatasets],
  );

  const createPlayground = useCallback(
    (linkedDatasetId?: string) => {
      const ds =
        allDatasets.find((d) => d.id === linkedDatasetId) ??
        allDatasets.find((d) =>
          agentId === "all" ? true : d.agentId === agentId,
        ) ??
        allDatasets[0];
      const id = `pg_local_${Date.now().toString(36)}`;
      const draft: PlaygroundFixture = {
        id,
        name: ds ? `${ds.name} · draft` : "Untitled draft",
        agentId:
          ds?.agentId ?? (agentId === "all" ? undefined : agentId) ?? undefined,
        datasetId: ds?.id,
        prompt: "You are a careful agent. Follow the task exactly.",
        model: "eden-router / grok-4.5",
        dirty: true,
        variants: [
          { id: "var_base", label: "Baseline", provider: "baseline" },
          { id: "var_cand", label: "Candidate", provider: "candidate" },
        ],
      };
      setExtraPlaygrounds((prev) => [draft, ...prev]);
      setPlaygroundId(id);
      setMode("playground");
      patchQuery({ mode: "playground", id, from: null });
    },
    [allDatasets, agentId, patchQuery],
  );

  const renamePlayground = useCallback(
    (id: string, name: string) => {
      setExtraPlaygrounds((prev) => {
        if (prev.some((p) => p.id === id)) {
          return prev.map((p) =>
            p.id === id ? { ...p, name, dirty: true } : p,
          );
        }
        const base =
          livePlaygrounds.find((p) => p.id === id) ?? playgroundById(id);
        if (!base) return prev;
        return [{ ...base, name, dirty: true }, ...prev];
      });
    },
    [livePlaygrounds],
  );

  const linkPlaygroundDataset = useCallback(
    (pgId: string, dsId: string) => {
      const ds = allDatasets.find((d) => d.id === dsId);
      setExtraPlaygrounds((prev) => {
        if (prev.some((p) => p.id === pgId)) {
          return prev.map((p) =>
            p.id === pgId
              ? {
                  ...p,
                  datasetId: dsId,
                  agentId: ds?.agentId ?? p.agentId,
                  dirty: true,
                }
              : p,
          );
        }
        const base =
          livePlaygrounds.find((p) => p.id === pgId) ?? playgroundById(pgId);
        if (!base) return prev;
        return [
          {
            ...base,
            datasetId: dsId,
            agentId: ds?.agentId ?? base.agentId,
            dirty: true,
          },
          ...prev,
        ];
      });
    },
    [allDatasets, livePlaygrounds],
  );

  useEffect(() => {
    const nextMode = parseEvalsMode(paramTab, paramMode);
    setMode(nextMode);
    if (paramBaseline) setBaselineId(paramBaseline);
    if (paramCompare) setCompareId(paramCompare);
    setLayout(parseLayout(paramLayout));
    setGradeFilter(parseGrade(paramGrade));
    if (paramDiff != null) setDiff(paramDiff === "1");
    setFocusCaseId(paramCase);
  }, [
    paramMode,
    paramTab,
    paramBaseline,
    paramCompare,
    paramLayout,
    paramGrade,
    paramDiff,
    paramCase,
  ]);

  // Dataset / playground selection from URL + live lists.
  useEffect(() => {
    const nextMode = parseEvalsMode(paramTab, paramMode);
    if (nextMode === "datasets") {
      const next =
        allDatasets.find((d) => d.id === paramId)?.id ??
        allDatasets[0]?.id ??
        "";
      if (next && next !== datasetId) setDatasetId(next);
      else if (!next && datasetId) setDatasetId("");
    } else if (nextMode === "playground") {
      const next =
        allPlaygrounds.find((p) => p.id === paramId)?.id ??
        allPlaygrounds[0]?.id ??
        "";
      if (next && next !== playgroundId) setPlaygroundId(next);
      else if (!next && playgroundId) setPlaygroundId("");
    }
     
  }, [paramId, paramTab, paramMode, allDatasets, allPlaygrounds]);

  // Seed compare pair once live experiments arrive (if URL didn't set them).
  useEffect(() => {
    if (paramBaseline || paramCompare) return;
    if (!defaults.baselineId && !defaults.compareId) return;
    if (!baselineId && defaults.baselineId) setBaselineId(defaults.baselineId);
    if (!compareId && defaults.compareId) setCompareId(defaults.compareId);
     
  }, [defaults.baselineId, defaults.compareId, paramBaseline, paramCompare]);

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    if (!paramFrom || handledFrom.current === paramFrom) return;
    handledFrom.current = paramFrom;

    const liveTraces = catalogTraces();
    const isTrace = Boolean(traceById(paramFrom) || liveTraces.some((t) => t.id === paramFrom));
    const isIssue = Boolean(issueById(paramFrom));
    if (!isTrace && !isIssue) return;

    let ds =
      (isTrace ? datasetForTrace(paramFrom) : undefined) ??
      (isIssue ? datasetForIssue(paramFrom) : undefined);

    const sourceAgent =
      (isTrace
        ? traceById(paramFrom)?.agentId ??
          liveTraces.find((t) => t.id === paramFrom)?.agentId
        : undefined) ?? issueById(paramFrom)?.agentId;

    if (!ds && sourceAgent) {
      const id = `ds_from_${sourceAgent}_${Date.now().toString(36)}`;
      ds = {
        id,
        name: "Untitled dataset",
        description: "",
        agentId: sourceAgent,
        source: isTrace ? "traces" : "issues",
        version: "v1",
        updatedAt: "just now",
        caseIds: [],
      };
      setExtraDatasets((prev) => [ds!, ...prev]);
      setRenamingDatasetId(id);
    }
    if (!ds) return;

    if (sourceAgent) setAgentId(sourceAgent);

    const fixtureCase =
      (isTrace ? caseForTrace(paramFrom) : caseForIssue(paramFrom)) ??
      (isIssue
        ? issueById(paramFrom)?.occurrenceTraceIds
            .map((tid) => caseForTrace(tid))
            .find(Boolean)
        : undefined) ??
      null;

    let caseId = fixtureCase?.id ?? null;

    if (!fixtureCase) {
      const draft = draftCaseFromSource(paramFrom, ds.id);
      if (draft) {
        caseId = draft.id;
        setExtraCases((prev) =>
          prev.some(
            (c) =>
              c.id === draft.id ||
              c.sourceTraceId === paramFrom ||
              c.sourceIssueId === paramFrom,
          )
            ? prev
            : [draft, ...prev],
        );
        const draftId = draft.id;
        const targetId = ds.id;
        const nextSource = isTrace ? "traces" : "issues";
        setExtraDatasets((prev) => {
          const hit = prev.find((d) => d.id === targetId);
          if (hit) {
            if (hit.caseIds.includes(draftId)) return prev;
            return prev.map((d) =>
              d.id === targetId
                ? {
                    ...d,
                    caseIds: [draftId, ...d.caseIds],
                    updatedAt: "just now",
                    source: nextSource,
                  }
                : d,
            );
          }
          const base =
            liveDatasets.find((d) => d.id === targetId) ??
            datasetById(targetId);
          if (!base) return prev;
          if (base.caseIds.includes(draftId)) {
            return [{ ...base, updatedAt: "just now" }, ...prev];
          }
          return [
            {
              ...base,
              caseIds: [draftId, ...base.caseIds],
              updatedAt: "just now",
              source: nextSource,
            },
            ...prev,
          ];
        });
      }
    }

    setMode("datasets");
    setDatasetId(ds.id);
    setFromHint(paramFrom);
    setDockCaseId(caseId);
    patchQuery({
      mode: "datasets",
      tab: null,
      id: ds.id,
      from: paramFrom,
      agent: sourceAgent ?? null,
      baselineId: null,
      compareId: null,
      case: null,
    });
  }, [paramFrom, patchQuery, setAgentId, liveDatasets]);

  const changeMode = useCallback(
    (next: EvalsMode) => {
      setMode(next);
      setFromHint(null);
      setFocusCaseId(null);
      setDockCaseId(null);
      if (next === "compare") {
        patchQuery({
          mode: null,
          tab: null,
          id: null,
          from: null,
          baselineId,
          compareId,
          case: null,
          failures: null,
        });
      } else if (next === "datasets") {
        patchQuery({
          mode: "datasets",
          tab: null,
          id: datasetId || defaultDatasetId() || null,
          from: null,
          baselineId: null,
          compareId: null,
          layout: null,
          grade: null,
          diff: null,
          failures: null,
          case: null,
        });
      } else {
        patchQuery({
          mode: "playground",
          tab: null,
          id: playgroundId || defaultPlaygroundId() || null,
          from: null,
          baselineId: null,
          compareId: null,
          layout: null,
          grade: null,
          diff: null,
          failures: null,
          case: null,
        });
      }
    },
    [patchQuery, baselineId, compareId, datasetId, playgroundId],
  );

  const openComparePair = useCallback(
    (pair: { baselineId: string; compareId: string }) => {
      setMode("compare");
      setBaselineId(pair.baselineId);
      setCompareId(pair.compareId);
      setFromHint(null);
      setDockCaseId(null);
      setLayout("summary");
      setGradeFilter("all");
      patchQuery({
        mode: null,
        tab: null,
        id: null,
        from: null,
        baselineId: pair.baselineId,
        compareId: pair.compareId,
        layout: null,
        grade: null,
        case: null,
        failures: null,
      });
    },
    [patchQuery],
  );

  const compareLatest = useCallback(
    (dsId: string) => {
      const pair = comparePairForDataset(dsId, allExperiments);
      if (!pair) return;
      openComparePair(pair);
    },
    [allExperiments, openComparePair],
  );

  const runExperiment = useCallback(
    (dsId: string) => {
      const ds = allDatasets.find((d) => d.id === dsId);
      const cases = casesFor(dsId);
      if (!ds || cases.length === 0) return;

      const prior = [
        ...extraExperiments.filter((e) => e.datasetId === dsId),
        ...experimentsForDataset(dsId),
      ];
      const completedPrior = prior.filter((e) => e.status === "completed");
      const runN = completedPrior.length + 1;
      const olderId =
        comparePairForDataset(dsId, allExperiments)?.compareId ??
        completedPrior[completedPrior.length - 1]?.id ??
        "";

      const expId = `exp_run_${Date.now().toString(36)}`;
      const avg =
        0.55 +
        (cases.reduce((s, c) => s + c.input.length, 0) % 40) / 100;

      const synthetic: ExperimentFixture = {
        id: expId,
        name: `${ds.name} · run ${runN}`,
        datasetId: dsId,
        status: "completed",
        createdAt: "just now",
        avgScores: { score: Number(avg.toFixed(2)) },
        latencyMs: 2800 + cases.length * 120,
        costUsd: 0.02 + cases.length * 0.008,
        errorRate: 0.1,
        suggestedBaselineId: olderId || undefined,
      };

      const results: ExperimentCaseResult[] = cases.map((c, i) => {
        const score = Math.max(
          0.1,
          Math.min(0.98, avg + ((i % 3) - 1) * 0.08),
        );
        const pass = score >= 0.55;
        return {
          experimentId: expId,
          caseId: c.id,
          output: pass
            ? `Pass · ${c.input.slice(0, 48)}`
            : `Fail · ${c.input.slice(0, 48)}`,
          scores: { score: Number(score.toFixed(2)) },
          latencyMs: 800 + i * 100,
          costUsd: 0.01,
          error: pass ? undefined : "below threshold",
        };
      });

      setExtraExperiments((prev) => [synthetic, ...prev]);
      setExtraResults((prev) => [...results, ...prev]);
      openComparePair({
        baselineId: olderId || expId,
        compareId: expId,
      });
    },
    [allDatasets, casesFor, allExperiments, extraExperiments, openComparePair],
  );

  const openRun = useCallback(
    (experimentId: string) => {
      const pair = comparePairForExperiment(experimentId, allExperiments);
      if (!pair) return;
      openComparePair(pair);
    },
    [allExperiments, openComparePair],
  );

  const switchDatasetOnCompare = useCallback(
    (dsId: string) => {
      const pair = comparePairForDataset(dsId, allExperiments);
      if (pair) {
        openComparePair(pair);
        return;
      }
      setBaselineId("");
      setCompareId("");
      patchQuery({
        mode: null,
        baselineId: null,
        compareId: null,
      });
    },
    [allExperiments, openComparePair, patchQuery],
  );

  const promotePlayground = useCallback(
    (pg: PlaygroundFixture, _prompt: string) => {
      if (!pg.datasetId) return;

      const fixtureLinked = [
        ...extraExperiments,
        ...experimentsForDataset(pg.datasetId),
      ].find((e) => e.playgroundId === pg.id && e.status === "completed");

      const matrix = matrixForPlayground(pg);
      const candidate =
        pg.variants.find((v) => v.provider === "candidate") ??
        pg.variants[pg.variants.length - 1];
      const cells = matrix.filter((m) => m.variantId === candidate?.id);
      const avg =
        cells.length === 0
          ? 0.5
          : cells.reduce((s, c) => s + c.score, 0) / cells.length;
      const expId = `exp_local_${pg.id}_${Date.now().toString(36)}`;
      const baselinePair = comparePairForDataset(
        pg.datasetId,
        allExperiments,
      );
      const olderId =
        baselinePair?.compareId ??
        fixtureLinked?.id ??
        baselinePair?.baselineId ??
        "";

      const synthetic: ExperimentFixture = {
        id: expId,
        name: `${pg.name} · saved`,
        datasetId: pg.datasetId,
        playgroundId: pg.id,
        status: "completed",
        createdAt: "just now",
        avgScores: { score: avg },
        latencyMs: 3200,
        costUsd: 0.05,
        errorRate:
          cells.filter((c) => !c.pass).length / Math.max(cells.length, 1),
        suggestedBaselineId: olderId || undefined,
      };

      const results: ExperimentCaseResult[] =
        cells.length > 0
          ? cells.map((c) => ({
              experimentId: expId,
              caseId: c.caseId,
              output: c.output,
              scores: { score: c.score },
              latencyMs: 1000,
              costUsd: 0.01,
              error: c.pass ? undefined : "fail",
            }))
          : casesFor(pg.datasetId).map((c, i) => ({
              experimentId: expId,
              caseId: c.id,
              output: c.input.slice(0, 60),
              scores: { score: 0.5 + (i % 3) * 0.1 },
              latencyMs: 900,
              costUsd: 0.01,
            }));

      setExtraExperiments((prev) => [synthetic, ...prev]);
      setExtraResults((prev) => [...results, ...prev]);
      setExtraPlaygrounds((prev) => {
        if (prev.some((p) => p.id === pg.id)) {
          return prev.map((p) =>
            p.id === pg.id ? { ...p, dirty: false, name: pg.name } : p,
          );
        }
        return prev;
      });
      openComparePair({
        baselineId: olderId || expId,
        compareId: expId,
      });
    },
    [extraExperiments, allExperiments, openComparePair, casesFor],
  );

  const scopeCounts = useMemo(() => {
    const map: Record<string, number> = { all: allDatasets.length };
    for (const d of allDatasets) {
      if (!d.agentId) continue;
      map[d.agentId] = (map[d.agentId] ?? 0) + 1;
    }
    return map;
  }, [allDatasets]);

  const isLoading =
    datasetsQuery.isLoading ||
    playgroundsQuery.isLoading ||
    experimentsQuery.isLoading;
  const isError =
    datasetsQuery.isError ||
    playgroundsQuery.isError ||
    experimentsQuery.isError;

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Evals"
        message="Select a workspace to view evals."
      />
    );
  }

  if (isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Evals" />
        <QueryLoadingPanel label="Loading evals…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Evals" />
        <QueryErrorPanel
          error={
            datasetsQuery.error ??
            playgroundsQuery.error ??
            experimentsQuery.error
          }
          onRetry={() => {
            void datasetsQuery.refetch();
            void playgroundsQuery.refetch();
            void experimentsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const metaCount =
    mode === "datasets"
      ? `${allDatasets.length} dataset${allDatasets.length === 1 ? "" : "s"}`
      : mode === "playground"
        ? `${allPlaygrounds.length} draft${allPlaygrounds.length === 1 ? "" : "s"}`
        : "Results";

  const meta = (
    <span className="type-meta">
      {scopeAgent ? scopeAgent.name : "All agents"} · {metaCount}
    </span>
  );

  // See the local-state comment above `extraDatasets` — none of these
  // surfaces persist to the backend, so surface a standing warning
  // whenever the session holds any local-only draft work.
  const hasUnsavedEvalsWork =
    extraDatasets.length > 0 ||
    hiddenDatasetIds.length > 0 ||
    extraCases.length > 0 ||
    extraExperiments.length > 0 ||
    extraPlaygrounds.length > 0;

  return (
    <div className="ds-page">
      <PageHeader
        title="Evals"
        meta={meta}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {mode !== "compare" ? (
              <label className="flex items-center gap-1.5">
                <span className="sr-only">Agent</span>
                <select
                  className="ds-input !h-8 !w-auto max-w-[10rem] !py-0 !text-[0.75rem]"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  aria-label="Filter by agent"
                >
                  <option value="all">
                    All agents
                    {scopeCounts.all != null ? ` (${scopeCounts.all})` : ""}
                  </option>
                  {catalogAgents().map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {scopeCounts[a.id] != null
                        ? ` (${scopeCounts[a.id]})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <EvalsModeNav value={mode} onChange={changeMode} />
          </div>
        }
      />

      {hasUnsavedEvalsWork ? (
        <div
          role="status"
          className="shrink-0 border-b border-[var(--warning)] bg-[var(--warning-muted)] px-5 py-2.5 sm:px-7"
        >
          <p className="type-meta text-[var(--text)]">
            <strong className="font-medium">Local draft only —</strong>{" "}
            dataset/case edits, experiment runs, and playground promotions
            made in this session aren&apos;t saved to the backend yet. They
            will be lost on refresh or navigation.
          </p>
        </div>
      ) : null}

      {mode === "compare" ? (
        <EvalsCompareView
          baselineId={baselineId}
          compareId={compareId}
          layout={layout}
          gradeFilter={gradeFilter}
          diff={diff}
          focusCaseId={focusCaseId}
          datasets={allDatasets}
          extraExperiments={extraExperiments}
          extraResults={extraResults}
          extraCases={extraCases}
          onBaseline={(id) => {
            setBaselineId(id);
            patchQuery({ baselineId: id });
          }}
          onCompare={(id) => {
            setCompareId(id);
            patchQuery({ compareId: id });
          }}
          onDatasetChange={switchDatasetOnCompare}
          onGoDatasets={() => changeMode("datasets")}
          onGoPlayground={() => changeMode("playground")}
          onLayout={(l) => {
            setLayout(l);
            patchQuery({ layout: l === "summary" ? null : l });
          }}
          onGrade={(g) => {
            setGradeFilter(g);
            patchQuery({ grade: g === "all" ? null : g });
          }}
          onDiff={(v) => {
            setDiff(v);
            patchQuery({ diff: v ? "1" : null });
          }}
          onFocusCase={(id) => {
            setFocusCaseId(id);
            patchQuery({ case: id });
          }}
        />
      ) : null}

      {mode === "datasets" ? (
        <EvalsDatasetsView
          agentId={agentId}
          datasets={allDatasets}
          selectedId={datasetId}
          fromHint={fromHint}
          focusCaseId={dockCaseId}
          extraCases={extraCases}
          extraExperiments={extraExperiments}
          renamingId={renamingDatasetId}
          onSelect={(id) => {
            setDatasetId(id);
            setDockCaseId(null);
            setRenamingDatasetId(null);
            patchQuery({ mode: "datasets", id, from: fromHint });
          }}
          onCompareLatest={compareLatest}
          onRunExperiment={runExperiment}
          onOpenRun={openRun}
          onCreateDataset={createDataset}
          onAddCase={addCase}
          onRenameDataset={renameDataset}
          onDeleteDataset={deleteDataset}
          onUpdateCase={updateCase}
          onDeleteCase={deleteCase}
          onTryDataset={(id) => createPlayground(id)}
        />
      ) : null}

      {mode === "playground" ? (
        <EvalsPlaygroundView
          agentId={agentId}
          playgrounds={allPlaygrounds}
          datasets={allDatasets}
          selectedId={playgroundId}
          extraCases={extraCases}
          onSelect={(id) => {
            setPlaygroundId(id);
            patchQuery({ mode: "playground", id });
          }}
          onCreate={() => createPlayground()}
          onLinkDataset={linkPlaygroundDataset}
          onRename={renamePlayground}
          onPromote={promotePlayground}
        />
      ) : null}
    </div>
  );
}

export default function LabEvalsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader
            title="Evals"
            meta={<span className="type-meta">Loading…</span>}
          />
        </div>
      }
    >
      <LabEvalsInner />
    </Suspense>
  );
}
