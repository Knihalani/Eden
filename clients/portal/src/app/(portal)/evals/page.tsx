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
import {
  datasetsApi,
  offlineExperimentsApi,
  playgroundApi,
} from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { useQueryClient } from "@tanstack/react-query";

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapCreatedDataset(
  created: { id: string; name: string; description?: string },
  agentId: string | "all",
): DatasetFixture {
  return {
    id: created.id,
    name: created.name,
    description: created.description ?? "",
    agentId: agentId === "all" ? null : agentId,
    source: "manual",
    version: "1",
    updatedAt: "just now",
    caseIds: [],
  };
}

function mapPersistedPlayground(
  playground: {
    id: string;
    name: string;
    config?: Record<string, unknown>;
  },
  fallback?: Partial<PlaygroundFixture>,
): PlaygroundFixture {
  const cfg = playground.config ?? {};
  const variantsRaw = Array.isArray(cfg.variants) ? cfg.variants : null;
  const variants =
    variantsRaw && variantsRaw.length > 0
      ? variantsRaw
          .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
          .map((v, i) => ({
            id: String(v.id ?? `var_${i}`),
            label: String(v.label ?? `Variant ${i + 1}`),
            provider: typeof v.provider === "string" ? v.provider : undefined,
            promptSnippet:
              typeof v.promptSnippet === "string" ? v.promptSnippet : undefined,
          }))
      : fallback?.variants ?? [
          { id: "var_base", label: "Baseline", provider: "baseline" },
          { id: "var_cand", label: "Candidate", provider: "candidate" },
        ];
  return {
    id: playground.id,
    name: playground.name,
    agentId:
      (typeof cfg.agent_id === "string" ? cfg.agent_id : undefined) ??
      fallback?.agentId,
    datasetId:
      (typeof cfg.dataset_id === "string" ? cfg.dataset_id : undefined) ??
      fallback?.datasetId,
    prompt:
      (typeof cfg.prompt === "string" ? cfg.prompt : undefined) ??
      fallback?.prompt ??
      "You are a careful agent. Follow the task exactly.",
    model:
      (typeof cfg.model === "string" ? cfg.model : undefined) ??
      fallback?.model ??
      "eden-router / deepseek-v4-flash",
    dirty: Boolean(cfg.dirty ?? fallback?.dirty ?? true),
    variants,
    lastRunId:
      typeof cfg.last_run_id === "string" ? cfg.last_run_id : fallback?.lastRunId,
  };
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
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
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
  // Optimistic overlays for in-flight CRUD; settled by portal query invalidation.
  const [extraDatasets, setExtraDatasets] = useState<DatasetFixture[]>([]);
  const [hiddenDatasetIds, setHiddenDatasetIds] = useState<string[]>([]);
  const [extraCases, setExtraCases] = useState<DatasetCaseFixture[]>([]);
  const [extraExperiments, setExtraExperiments] = useState<
    ExperimentFixture[]
  >([]);
  const [extraResults] = useState<ExperimentCaseResult[]>([]);
  const [extraPlaygrounds, setExtraPlaygrounds] = useState<
    PlaygroundFixture[]
  >([]);
  const [renamingDatasetId, setRenamingDatasetId] = useState<string | null>(
    null,
  );
  const handledFrom = useRef<string | null>(null);

  const invalidateEvals = useCallback(
    async (which: "datasets" | "playgrounds" | "experiments" | "all" = "all") => {
      if (!orgId) return;
      const jobs: Promise<unknown>[] = [];
      if (which === "datasets" || which === "all") {
        jobs.push(
          queryClient.invalidateQueries({
            queryKey: queryKeys.portal.evalDatasets(orgId),
          }),
        );
      }
      if (which === "playgrounds" || which === "all") {
        jobs.push(
          queryClient.invalidateQueries({
            queryKey: queryKeys.portal.evalPlaygrounds(orgId),
          }),
        );
      }
      if (which === "experiments" || which === "all") {
        jobs.push(
          queryClient.invalidateQueries({
            queryKey: queryKeys.portal.evalExperiments(orgId),
          }),
        );
      }
      await Promise.all(jobs);
    },
    [orgId, queryClient],
  );

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
      // Only real case content — never invent "Case N" placeholders.
      return [...local, ...fixture];
    },
    [extraCases],
  );

  const createDataset = useCallback(() => {
    if (!orgId) {
      pushToast({ title: "Not available", tone: "fail" });
      return;
    }
    const tempId = `ds_local_${Date.now().toString(36)}`;
    const draft = mapCreatedDataset(
      { id: tempId, name: "Untitled dataset" },
      agentId,
    );
    setExtraDatasets((prev) => [draft, ...prev]);
    setDatasetId(tempId);
    setRenamingDatasetId(tempId);
    setMode("datasets");
    patchQuery({ mode: "datasets", id: tempId, from: null });

    void (async () => {
      try {
        const created = await datasetsApi.create(orgId, {
          name: "Untitled dataset",
        });
        const mapped = mapCreatedDataset(created, agentId);
        setExtraDatasets((prev) =>
          prev.map((d) => (d.id === tempId ? mapped : d)),
        );
        setDatasetId(mapped.id);
        setRenamingDatasetId(mapped.id);
        patchQuery({ mode: "datasets", id: mapped.id, from: null });
      } catch (err) {
        setExtraDatasets((prev) => prev.filter((d) => d.id !== tempId));
        setDatasetId("");
        setRenamingDatasetId(null);
        pushToast({
          title: "Create dataset failed",
          body: errMessage(err),
          tone: "fail",
        });
      } finally {
        await invalidateEvals("datasets");
      }
    })();
  }, [agentId, invalidateEvals, orgId, patchQuery, pushToast]);

  const renameDataset = useCallback(
    (id: string, name: string) => {
      setExtraDatasets((prev) => {
        const next = cloneDatasetIntoExtras(id, prev, liveDatasets);
        return next.map((d) =>
          d.id === id ? { ...d, name, updatedAt: "just now" } : d,
        );
      });
      setRenamingDatasetId(null);
      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          await datasetsApi.patch(orgId, id, { name });
        } catch (err) {
          pushToast({
            title: "Rename failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("datasets");
        }
      })();
    },
    [invalidateEvals, liveDatasets, orgId, pushToast],
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

      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          await datasetsApi.delete(orgId, id);
        } catch (err) {
          setHiddenDatasetIds((prev) => prev.filter((x) => x !== id));
          pushToast({
            title: "Delete failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("datasets");
        }
      })();
    },
    [allDatasets, invalidateEvals, orgId, patchQuery, pushToast],
  );

  const addCase = useCallback(
    (dsId: string) => {
      const tempId = `case_local_${Date.now().toString(36)}`;
      const draft: DatasetCaseFixture = {
        id: tempId,
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
                caseIds: [...d.caseIds, tempId],
                updatedAt: "just now",
              }
            : d,
        );
      });
      setDockCaseId(tempId);

      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          const row = await datasetsApi.addRow(orgId, dsId, { input: "" });
          setExtraCases((prev) =>
            prev.map((c) =>
              c.id === tempId
                ? {
                    ...c,
                    id: row.id,
                    input: row.input ?? "",
                    expected: row.expected_output || undefined,
                  }
                : c,
            ),
          );
          setExtraDatasets((prev) =>
            prev.map((d) =>
              d.id === dsId
                ? {
                    ...d,
                    caseIds: d.caseIds.map((cid) =>
                      cid === tempId ? row.id : cid,
                    ),
                  }
                : d,
            ),
          );
          setDockCaseId((cur) => (cur === tempId ? row.id : cur));
        } catch (err) {
          setExtraCases((prev) => prev.filter((c) => c.id !== tempId));
          setExtraDatasets((prev) =>
            prev.map((d) =>
              d.id === dsId
                ? {
                    ...d,
                    caseIds: d.caseIds.filter((cid) => cid !== tempId),
                  }
                : d,
            ),
          );
          setDockCaseId((cur) => (cur === tempId ? null : cur));
          pushToast({
            title: "Add case failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("datasets");
        }
      })();
    },
    [invalidateEvals, liveDatasets, orgId, pushToast],
  );

  const updateCase = useCallback(
    (caseId: string, patch: { input?: string; expected?: string }) => {
      const datasetId =
        extraCases.find((c) => c.id === caseId)?.datasetId ??
        allDatasets.find((d) => d.caseIds.includes(caseId))?.id ??
        DATASET_CASES.find((c) => c.id === caseId)?.datasetId ??
        "";

      setExtraCases((prev) => {
        const hit = prev.find((c) => c.id === caseId);
        if (hit) {
          return prev.map((c) => (c.id === caseId ? { ...c, ...patch } : c));
        }
        const fixture =
          DATASET_CASES.find((c) => c.id === caseId) ??
          (datasetId
            ? casesFor(datasetId).find((c) => c.id === caseId)
            : undefined);
        if (!fixture) return prev;
        return [{ ...fixture, ...patch }, ...prev];
      });

      if (!orgId || !datasetId) {
        if (!orgId) pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          await datasetsApi.updateRow(orgId, datasetId, caseId, {
            input: patch.input,
            expected_output: patch.expected,
          });
        } catch (err) {
          pushToast({
            title: "Update case failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("datasets");
        }
      })();
    },
    [allDatasets, casesFor, extraCases, invalidateEvals, orgId, pushToast],
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

      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          await datasetsApi.deleteRow(orgId, dsId, caseId);
        } catch (err) {
          pushToast({
            title: "Delete case failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("datasets");
        }
      })();
    },
    [invalidateEvals, liveDatasets, orgId, pushToast],
  );

  const createPlayground = useCallback(
    (linkedDatasetId?: string) => {
      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      const ds =
        allDatasets.find((d) => d.id === linkedDatasetId) ??
        allDatasets.find((d) =>
          agentId === "all" ? true : d.agentId === agentId,
        ) ??
        allDatasets[0];
      const tempId = `pg_local_${Date.now().toString(36)}`;
      const draft: PlaygroundFixture = {
        id: tempId,
        name: ds ? `${ds.name} · draft` : "Untitled draft",
        agentId:
          ds?.agentId ?? (agentId === "all" ? undefined : agentId) ?? undefined,
        datasetId: ds?.id,
        prompt: "You are a careful agent. Follow the task exactly.",
        model: "eden-router / deepseek-v4-flash",
        dirty: true,
        variants: [
          { id: "var_base", label: "Baseline", provider: "baseline" },
          { id: "var_cand", label: "Candidate", provider: "candidate" },
        ],
      };
      setExtraPlaygrounds((prev) => [draft, ...prev]);
      setPlaygroundId(tempId);
      setMode("playground");
      patchQuery({ mode: "playground", id: tempId, from: null });

      void (async () => {
        try {
          const { playground } = await playgroundApi.create(orgId, {
            name: draft.name,
          });
          let next = playground;
          if (ds?.id) {
            const patched = await playgroundApi.patch(orgId, playground.id, {
              config: {
                ...playground.config,
                dataset_id: ds.id,
                agent_id: ds.agentId ?? draft.agentId,
                prompt: draft.prompt,
                model: draft.model,
                dirty: true,
                variants: draft.variants,
              },
            });
            next = patched.playground;
          }
          const mapped = mapPersistedPlayground(next, draft);
          setExtraPlaygrounds((prev) =>
            prev.map((p) => (p.id === tempId ? mapped : p)),
          );
          setPlaygroundId(mapped.id);
          patchQuery({ mode: "playground", id: mapped.id, from: null });
        } catch (err) {
          setExtraPlaygrounds((prev) => prev.filter((p) => p.id !== tempId));
          setPlaygroundId("");
          pushToast({
            title: "Create playground failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("playgrounds");
        }
      })();
    },
    [allDatasets, agentId, invalidateEvals, orgId, patchQuery, pushToast],
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
      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          await playgroundApi.patch(orgId, id, { name });
        } catch (err) {
          pushToast({
            title: "Rename failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("playgrounds");
        }
      })();
    },
    [invalidateEvals, livePlaygrounds, orgId, pushToast],
  );

  const linkPlaygroundDataset = useCallback(
    (pgId: string, dsId: string) => {
      const ds = allDatasets.find((d) => d.id === dsId);
      let baseConfig: Record<string, unknown> = {};
      setExtraPlaygrounds((prev) => {
        if (prev.some((p) => p.id === pgId)) {
          return prev.map((p) => {
            if (p.id !== pgId) return p;
            baseConfig = {
              prompt: p.prompt,
              model: p.model,
              dirty: true,
              variants: p.variants,
              dataset_id: dsId,
              agent_id: ds?.agentId ?? p.agentId,
            };
            return {
              ...p,
              datasetId: dsId,
              agentId: ds?.agentId ?? p.agentId,
              dirty: true,
            };
          });
        }
        const base =
          livePlaygrounds.find((p) => p.id === pgId) ?? playgroundById(pgId);
        if (!base) return prev;
        baseConfig = {
          prompt: base.prompt,
          model: base.model,
          dirty: true,
          variants: base.variants,
          dataset_id: dsId,
          agent_id: ds?.agentId ?? base.agentId,
        };
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
      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }
      void (async () => {
        try {
          const current = await playgroundApi.get(orgId, pgId);
          await playgroundApi.patch(orgId, pgId, {
            config: {
              ...current.playground.config,
              ...baseConfig,
              dataset_id: dsId,
              agent_id: ds?.agentId ?? current.playground.config?.agent_id,
            },
          });
        } catch (err) {
          pushToast({
            title: "Link dataset failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("playgrounds");
        }
      })();
    },
    [allDatasets, invalidateEvals, livePlaygrounds, orgId, pushToast],
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
    // `from=` is the Datasets promote handoff — never steal Playground deep-links.
    if (paramMode === "playground") return;
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
  }, [paramFrom, paramMode, patchQuery, setAgentId, liveDatasets]);

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
      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }

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

      void (async () => {
        try {
          const { experiment } = await offlineExperimentsApi.create(orgId, {
            name: `${ds.name} · run ${runN}`,
            dataset_id: dsId,
          });
          const expId = String(experiment.id ?? "");
          if (!expId) throw new Error("No experiment id returned");
          await offlineExperimentsApi.run(orgId, expId);
          const mapped: ExperimentFixture = {
            id: expId,
            name: String(experiment.name ?? `${ds.name} · run ${runN}`),
            datasetId: dsId,
            status: "completed",
            createdAt: "just now",
            avgScores: {},
            latencyMs: null,
            costUsd: null,
            errorRate: null,
            suggestedBaselineId: olderId || undefined,
          };
          setExtraExperiments((prev) => [
            mapped,
            ...prev.filter((e) => e.id !== expId),
          ]);
          openComparePair({
            baselineId: olderId || expId,
            compareId: expId,
          });
        } catch (err) {
          pushToast({
            title: "Run experiment failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("experiments");
        }
      })();
    },
    [
      allDatasets,
      allExperiments,
      casesFor,
      extraExperiments,
      invalidateEvals,
      openComparePair,
      orgId,
      pushToast,
    ],
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
      if (!orgId) {
        pushToast({ title: "Not available", tone: "fail" });
        return;
      }

      const fixtureLinked = [
        ...extraExperiments,
        ...experimentsForDataset(pg.datasetId),
      ].find((e) => e.playgroundId === pg.id && e.status === "completed");
      const baselinePair = comparePairForDataset(
        pg.datasetId,
        allExperiments,
      );
      const olderId =
        baselinePair?.compareId ??
        fixtureLinked?.id ??
        baselinePair?.baselineId ??
        "";

      void (async () => {
        try {
          const result = await playgroundApi.promoteExperiment(orgId, pg.id, {
            name: `${pg.name} · saved`,
            dataset_id: pg.datasetId,
          });
          const experiment = (result.experiment ?? {}) as Record<
            string,
            unknown
          >;
          const expId = String(experiment.id ?? "");
          if (!expId) throw new Error("No experiment id returned");

          const mapped: ExperimentFixture = {
            id: expId,
            name: String(experiment.name ?? `${pg.name} · saved`),
            datasetId: pg.datasetId!,
            playgroundId: pg.id,
            status: "completed",
            createdAt: "just now",
            avgScores: {},
            latencyMs: null,
            costUsd: null,
            errorRate: null,
            suggestedBaselineId: olderId || undefined,
          };
          setExtraExperiments((prev) => [
            mapped,
            ...prev.filter((e) => e.id !== expId),
          ]);
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
        } catch (err) {
          pushToast({
            title: "Promote failed",
            body: errMessage(err),
            tone: "fail",
          });
        } finally {
          await invalidateEvals("all");
        }
      })();
    },
    [
      allExperiments,
      extraExperiments,
      invalidateEvals,
      openComparePair,
      orgId,
      pushToast,
    ],
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
  // Datasets-only outages must not blank the whole Evals hub — show an
  // empty datasets pane with a retry note instead of a full-page ApiError.
  const datasetsUnavailable = datasetsQuery.isError;
  const isError = playgroundsQuery.isError || experimentsQuery.isError;

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
          error={playgroundsQuery.error ?? experimentsQuery.error}
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
  // surfaces persist to the backend, so surface a standing honesty banner.
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

      {datasetsUnavailable && mode === "datasets" ? (
        <div
          role="status"
          className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--bg-inset)] px-5 py-2.5 sm:px-7"
        >
          <p className="type-meta text-[var(--text)]">
            Datasets are temporarily unavailable. Other eval surfaces still
            work.
          </p>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => void datasetsQuery.refetch()}
          >
            Retry
          </button>
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
