"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { useResourceUrlState } from "@/components/portal-os";
import { usePagePerf } from "@/lib/perf";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { offlineExperimentsApi } from "@/lib/api";
import {
  interpretOfflineRunResult,
  isTerminalExperimentStatus,
} from "@/lib/eval-run-outcome";
import { useCompareKeyboardNav } from "./use-compare-keyboard-nav";
import { filterFailingOrRegressedDatapoints } from "./compare-grades";
import {
  BASELINE_PREF_KEY,
  type CompareLayout,
  type CompareMeta,
  type Datapoint,
  type DiffMode,
  type ExperimentRow,
} from "./types";

export const WAVE_E4_EXPERIMENTS_COMPLETED = true;
export const WAVE_E4_COMPARE_MATRIX_COMPLETED = true;
export const WAVE_E4_BASELINE_COMPLETED = true;
export const WAVE_E4_DIFF_GRADES_COMPLETED = true;
export const WAVE_E6_FAILURES_FILTER_COMPLETED = true;
export const WAVE_E6_DIFF_RAIL_COMPLETED = true;

function readBaselinePrefs(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BASELINE_PREF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBaselinePref(datasetId: string, baselineId: string) {
  if (typeof window === "undefined" || !datasetId || !baselineId) return;
  try {
    const next = { ...readBaselinePrefs(), [datasetId]: baselineId };
    window.localStorage.setItem(BASELINE_PREF_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

function parseLayout(raw: string | null): CompareLayout {
  if (raw === "summary" || raw === "list" || raw === "grid") return raw;
  return "grid";
}

function parseDiffMode(raw: string | null): DiffMode {
  if (raw === "expected-output") return "expected-output";
  return "base-comparison";
}

function parseFailuresOnly(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Default baseline: URL → localStorage prefer same-dataset → latest other same-dataset.
 */
export function resolveDefaultBaseline(
  treatmentId: string,
  rows: ExperimentRow[],
  preferredByDataset: Record<string, string>,
): string | undefined {
  const treatment = rows.find((r) => r.id === treatmentId);
  if (!treatment) return undefined;
  const preferred = preferredByDataset[treatment.dataset_id];
  if (preferred && preferred !== treatmentId) {
    const ok = rows.some(
      (r) => r.id === preferred && r.dataset_id === treatment.dataset_id,
    );
    if (ok) return preferred;
  }
  const peers = rows
    .filter((r) => r.dataset_id === treatment.dataset_id && r.id !== treatmentId)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  return peers[0]?.id;
}

export function useExperimentsPage() {
  const { currentOrg } = useOrg();
  usePagePerf("/experiments");
  const toast = useToast();
  const embedded = useEmbeddedSurface();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const experimentId = urlState.experimentId;

  const baselineId = searchParams.get("baselineId") ?? undefined;
  const layout = parseLayout(searchParams.get("compareLayout"));
  const diffMode = parseDiffMode(searchParams.get("diffMode"));
  const failuresOnly = parseFailuresOnly(searchParams.get("failuresOnly"));

  const [rows, setRows] = useState<ExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [datapoints, setDatapoints] = useState<Datapoint[]>([]);
  const [compareMeta, setCompareMeta] = useState<CompareMeta | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [baselinePrefs, setBaselinePrefs] = useState<Record<string, string>>({});
  const baselineSeededFor = useRef<string | null>(null);

  useEffect(() => {
    setBaselinePrefs(readBaselinePrefs());
  }, []);

  const patchCompareUrl = useCallback(
    (
      patch: {
        baselineId?: string | null;
        compareLayout?: CompareLayout | null;
        diffMode?: DiffMode | null;
        failuresOnly?: boolean | null;
      },
      opts?: { replace?: boolean },
    ) => {
      const params = new URLSearchParams(searchParams.toString());
      if ("baselineId" in patch) {
        if (patch.baselineId === null) params.delete("baselineId");
        else if (patch.baselineId === undefined) {
          /* no-op */
        } else params.set("baselineId", patch.baselineId);
      }
      if ("compareLayout" in patch) {
        if (!patch.compareLayout || patch.compareLayout === "grid") {
          params.delete("compareLayout");
        } else {
          params.set("compareLayout", patch.compareLayout);
        }
      }
      if ("diffMode" in patch) {
        if (!patch.diffMode || patch.diffMode === "base-comparison") {
          params.delete("diffMode");
        } else {
          params.set("diffMode", patch.diffMode);
        }
      }
      if ("failuresOnly" in patch) {
        if (!patch.failuresOnly) params.delete("failuresOnly");
        else params.set("failuresOnly", "1");
      }
      const qs = params.toString();
      if (qs === searchParams.toString()) return;
      const nav = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
      if (opts?.replace === false) router.push(nav, { scroll: false });
      else router.replace(nav, { scroll: false });
    },
    [router, searchParams],
  );

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await offlineExperimentsApi.list(currentOrg.id);
      setRows((res.experiments as ExperimentRow[]) || []);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to load experiments";
      setLoadError(message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const effectiveBaselineId = useMemo(() => {
    if (!experimentId) return undefined;
    // Explicit URL clear sentinel — do not auto-resolve.
    if (baselineId === "__none__") return undefined;
    if (baselineId && baselineId !== experimentId) return baselineId;
    if (selected.size === 2) {
      const other = [...selected].find((id) => id !== experimentId);
      if (other) return other;
    }
    return resolveDefaultBaseline(experimentId, rows, baselinePrefs);
  }, [experimentId, baselineId, selected, rows, baselinePrefs]);

  const loadCompare = useCallback(
    async (id: string, baseline?: string) => {
      if (!currentOrg?.id) return;
      setSummaryLoading(true);
      setCompareError(null);
      try {
        const res = await offlineExperimentsApi.compare(
          currentOrg.id,
          id,
          baseline,
        );
        setSummary((res.compare?.summary as Record<string, number>) || null);
        setDatapoints((res.compare?.datapoints as Datapoint[]) || []);
        setCompareMeta({
          synthetic: Boolean(res.compare?.synthetic),
          method:
            typeof res.compare?.method === "string"
              ? res.compare.method
              : undefined,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Compare failed";
        setCompareError(message);
        setSummary(null);
        setDatapoints([]);
        setCompareMeta(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [currentOrg?.id],
  );

  useEffect(() => {
    if (!experimentId || !currentOrg?.id) {
      setSummary(null);
      setDatapoints([]);
      setCompareMeta(null);
      setCompareError(null);
      return;
    }
    void loadCompare(experimentId, effectiveBaselineId);
  }, [experimentId, currentOrg?.id, loadCompare, effectiveBaselineId]);

  // Seed URL baseline once per opened experiment (do not fight explicit clear).
  useEffect(() => {
    if (!experimentId) {
      baselineSeededFor.current = null;
      return;
    }
    if (baselineId === "__none__") {
      baselineSeededFor.current = experimentId;
      return;
    }
    if (baselineId) {
      baselineSeededFor.current = experimentId;
      return;
    }
    if (baselineSeededFor.current === experimentId) return;
    if (rows.length === 0) return;
    const resolved = resolveDefaultBaseline(
      experimentId,
      rows,
      baselinePrefs,
    );
    baselineSeededFor.current = experimentId;
    if (resolved) {
      patchCompareUrl({ baselineId: resolved });
    }
  }, [experimentId, baselineId, rows, baselinePrefs, patchCompareUrl]);

  const pollUntilTerminal = useCallback(
    async (id: string): Promise<"completed" | "failed" | "timeout"> => {
      if (!currentOrg?.id) return "timeout";
      const maxAttempts = 30;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        const res = await offlineExperimentsApi.list(currentOrg.id);
        const experiments = (res.experiments as ExperimentRow[]) || [];
        setRows(experiments);
        const row = experiments.find((e) => e.id === id);
        if (!row) continue;
        if (row.status === "completed") return "completed";
        if (row.status === "failed") return "failed";
        if (isTerminalExperimentStatus(row.status)) return "failed";
      }
      return "timeout";
    },
    [currentOrg?.id],
  );

  const runExperiment = async (id: string) => {
    if (!currentOrg?.id || runningId) return;
    setRunningId(id);
    setRunError(null);
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "running" } : r)),
    );
    try {
      const res = await offlineExperimentsApi.run(currentOrg.id, id);
      const outcome = interpretOfflineRunResult(res.result);
      if (outcome.kind === "in_progress") {
        const terminal = await pollUntilTerminal(id);
        if (terminal === "completed") {
          toast.success(
            outcome.synthetic
              ? "Heuristic stub run finished — not a live model eval"
              : "Experiment completed",
          );
        } else if (terminal === "failed") {
          const message = "Experiment run failed";
          setRunError(message);
          toast.error(message);
        } else {
          const message = "Timed out waiting for experiment status";
          setRunError(message);
          toast.error(message);
        }
      } else if (outcome.kind === "completed") {
        toast.success(outcome.message);
      } else {
        setRunError(outcome.message);
        toast.error(outcome.message);
      }
      await load();
      setUrlState({ experimentId: id });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Run failed";
      setRunError(message);
      toast.error(message);
      await load();
    } finally {
      setRunningId(null);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= 2) next.clear();
        next.add(id);
      }
      return next;
    });
  };

  const compareSelected = () => {
    const ids = [...selected];
    if (ids.length < 2) {
      toast.error("Select exactly two experiments");
      return;
    }
    const [a, b] = ids;
    const rowA = rows.find((r) => r.id === a);
    const rowB = rows.find((r) => r.id === b);
    // Newer = treatment; older = baseline (same-dataset preference already in pickers).
    const aTime = rowA ? new Date(rowA.created_at).getTime() : 0;
    const bTime = rowB ? new Date(rowB.created_at).getTime() : 0;
    const treatmentId = aTime >= bTime ? a! : b!;
    const baseId = treatmentId === a ? b! : a!;
    setUrlState({ experimentId: treatmentId });
    patchCompareUrl({ baselineId: baseId });
    if (rowA?.dataset_id) writeBaselinePref(rowA.dataset_id, baseId);
    setBaselinePrefs(readBaselinePrefs());
  };

  const setBaseline = (id: string | undefined) => {
    if (!id || id === experimentId) {
      patchCompareUrl({ baselineId: "__none__" });
      baselineSeededFor.current = experimentId ?? null;
      return;
    }
    patchCompareUrl({ baselineId: id });
    const treatment = rows.find((r) => r.id === experimentId);
    if (treatment?.dataset_id) {
      writeBaselinePref(treatment.dataset_id, id);
      setBaselinePrefs(readBaselinePrefs());
    }
  };

  const openExperiment = useCallback(
    (id: string) => {
      baselineSeededFor.current = null;
      setUrlState({ experimentId: id });
      // Drop stale baseline from another treatment; seed effect will re-resolve.
      patchCompareUrl({ baselineId: null });
    },
    [setUrlState, patchCompareUrl],
  );

  const setLayout = (next: CompareLayout) => {
    patchCompareUrl({ compareLayout: next });
  };

  const setDiffMode = (next: DiffMode) => {
    patchCompareUrl({ diffMode: next });
  };

  const setFailuresOnly = (next: boolean) => {
    patchCompareUrl({ failuresOnly: next });
  };

  const closeDetail = () => {
    setUrlState({ experimentId: undefined });
    patchCompareUrl({ baselineId: null });
    baselineSeededFor.current = null;
    setSummary(null);
    setDatapoints([]);
    setCompareMeta(null);
    setCompareError(null);
    setDiffOpen(null);
  };

  const selectedRow = experimentId
    ? (rows.find((r) => r.id === experimentId) ?? null)
    : null;
  const selectedIndex = experimentId
    ? rows.findIndex((r) => r.id === experimentId)
    : -1;
  const baselineRow = effectiveBaselineId
    ? (rows.find((r) => r.id === effectiveBaselineId) ?? null)
    : null;

  const baselineCandidates = useMemo(() => {
    if (!selectedRow) return rows.filter((r) => r.id !== experimentId);
    return rows.filter(
      (r) =>
        r.id !== experimentId &&
        (r.dataset_id === selectedRow.dataset_id || !selectedRow.dataset_id),
    );
  }, [rows, experimentId, selectedRow]);

  // E6.2 — list j/k when compare closed; datapoint j/k when panel open.
  useListKeyboardNav(
    rows.length,
    selectedIndex >= 0 ? selectedIndex : 0,
    (idx) => {
      const row = rows[idx];
      if (row) openExperiment(row.id);
    },
    !experimentId && rows.length > 0,
  );
  const compareNavDatapoints = useMemo(
    () =>
      failuresOnly
        ? filterFailingOrRegressedDatapoints(datapoints)
        : datapoints,
    [datapoints, failuresOnly],
  );
  useCompareKeyboardNav(
    compareNavDatapoints,
    diffOpen,
    setDiffOpen,
    Boolean(experimentId) && compareNavDatapoints.length > 0,
  );

  return {
    currentOrg,
    embedded,
    rows,
    loading,
    loadError,
    load,
    summary,
    datapoints,
    compareMeta,
    summaryLoading,
    compareError,
    loadCompare,
    selected,
    toggleSelect,
    compareSelected,
    experimentId,
    selectedRow,
    selectedIndex,
    setUrlState,
    effectiveBaselineId,
    baselineRow,
    baselineCandidates,
    setBaseline,
    layout,
    setLayout,
    diffMode,
    setDiffMode,
    failuresOnly,
    setFailuresOnly,
    diffOpen,
    setDiffOpen,
    runningId,
    runError,
    setRunError,
    runExperiment,
    closeDetail,
    openExperiment,
  };
}
