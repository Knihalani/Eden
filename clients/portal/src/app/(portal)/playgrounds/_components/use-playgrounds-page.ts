"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import {
  playgroundApi,
  datasetsApi,
  type PersistedPlayground,
  type Dataset,
} from "@/lib/api";
import { experimentHref } from "@/lib/portal-cross-links";
import { usePagePerf } from "@/lib/perf";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import type { RunMatrix } from "./run-matrix-types";

export const WAVE_E3_PLAYGROUNDS_COMPLETED = true;
export const WAVE_E3_FROM_SPAN_COMPLETED = true;
export const WAVE_E3_PROMOTE_COMPARE_READY = true;

const FROM_PRODUCTION_KEY = "eden.playground.fromProduction";

type FromProduction = {
  traceId: string;
  spanId?: string;
  playgroundId: string;
};

function readFromProductionStorage(): FromProduction | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(FROM_PRODUCTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FromProduction;
    if (!parsed?.traceId || !parsed?.playgroundId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeFromProductionStorage(value: FromProduction) {
  try {
    sessionStorage.setItem(FROM_PRODUCTION_KEY, JSON.stringify(value));
  } catch {
    /* ignore quota / private mode */
  }
}

function clearFromProductionStorage() {
  try {
    sessionStorage.removeItem(FROM_PRODUCTION_KEY);
  } catch {
    /* ignore */
  }
}

export function usePlaygroundsPage() {
  const { currentOrg } = useOrg();
  usePagePerf("/playgrounds");
  const toast = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const embedded = false;
  const orgId = currentOrg?.id ?? null;
  const [active, setActive] = useState<PersistedPlayground | null>(null);
  const [userPrompt, setUserPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunMatrix | null>(null);
  const [fromProduction, setFromProduction] = useState<FromProduction | null>(null);

  const listQuery = useOrgQuery(
    queryKeys.playgrounds.list(orgId),
    orgId,
    async () => {
      const { fetchApi } = await import("@/lib/api/core");
      // Playgrounds list is authoritative; datasets are soft-fail so a
      // datasets outage cannot false-empty / false-error the playground list.
      const pg = await fetchApi<{ playgrounds: PersistedPlayground[]; total: number }>(
        `/orgs/${orgId}/playgrounds?limit=100`,
        { headers: { "X-Org-Id": orgId! } },
      );
      let datasets: Dataset[] = [];
      try {
        const ds = await datasetsApi.list(orgId!);
        datasets = (ds.datasets || []).slice(0, 100) as Dataset[];
      } catch {
        datasets = [];
      }
      // B13: portal requests bounded playground lists (A7 owns API defaults).
      return {
        playgrounds: pg.playgrounds || [],
        datasets,
      };
    },
  );
  const playgrounds = listQuery.data?.playgrounds ?? [];
  const datasets = listQuery.data?.datasets ?? [];
  const loading =
    (listQuery.isLoading || listQuery.isPending) && playgrounds.length === 0;
  const listError = listQuery.isError
    ? (listQuery.error?.message ?? "Load failed")
    : null;

  useEffect(() => {
    if (!active && playgrounds[0]) setActive(playgrounds[0]);
  }, [playgrounds, active]);

  // Hydrate From production chip across remount (router.replace clears query params).
  useEffect(() => {
    const stored = readFromProductionStorage();
    if (stored) setFromProduction(stored);
  }, []);

  const load = useCallback(async () => {
    try {
      await listQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Load failed");
    }
  }, [listQuery, toast]);

  // Open-from-span: ?trace_id=&span_id= (M8 — keep span_id; show From production chip)
  useEffect(() => {
    const traceId = searchParams.get("trace_id");
    if (!traceId || !currentOrg?.id) return;
    const spanId = searchParams.get("span_id") || undefined;
    void (async () => {
      try {
        const res = await playgroundApi.fromSpan(currentOrg.id, {
          trace_id: traceId,
          span_id: spanId,
          messages: [{ role: "user", content: `Replay from trace ${traceId}` }],
        });
        setActive(res.playground);
        const chip: FromProduction = {
          traceId,
          spanId,
          playgroundId: res.playground.id,
        };
        setFromProduction(chip);
        writeFromProductionStorage(chip);
        await listQuery.refetch();
        toast.success("Playground created from span");
        router.replace("/evals?tab=playgrounds");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "from-span failed");
      }
    })();
  }, [searchParams, currentOrg?.id]);

  // Wave 9: ?prompt= from Improve Prompts → prefill task system template
  useEffect(() => {
    const promptKey = searchParams.get("prompt")?.trim();
    if (!promptKey || !currentOrg?.id) return;
    // Span deep-link wins when both present
    if (searchParams.get("trace_id")) return;
    void (async () => {
      try {
        const { fetchApi } = await import("@/lib/api/core");
        const list = await fetchApi<{
          data?: { prompts?: Array<{ id: string; name: string }> };
        }>(`/orgs/${currentOrg.id}/prompts?limit=100`, {
          headers: { "X-Org-Id": currentOrg.id },
        });
        const prompts = list.data?.prompts ?? [];
        const match =
          prompts.find((p) => p.name === promptKey) ??
          prompts.find((p) => p.id === promptKey);
        const name = match?.name ?? promptKey;
        const versionsRes = await fetchApi<{
          data?: { versions?: Array<{ template?: string; model?: string }> };
        }>(`/orgs/${currentOrg.id}/prompts/${encodeURIComponent(name)}`, {
          headers: { "X-Org-Id": currentOrg.id },
        });
        const latest = versionsRes.data?.versions?.[0];
        const template = (latest?.template ?? "").trim();
        const model = (latest?.model || "gpt-4o").trim() || "gpt-4o";
        if (!template) {
          toast.error("Prompt has no published version to iterate");
          router.replace("/evals?tab=playgrounds");
          return;
        }
        const res = await playgroundApi.create(currentOrg.id, {
          name: `Iterate · ${name}`,
          config: {
            tasks: [
              {
                id: "task_a",
                label: "A",
                system: template,
                user: "{{user}}",
                model,
                tools: [],
              },
              {
                id: "task_b",
                label: "B",
                system: template,
                user: "{{user}}",
                model,
                tools: [],
              },
            ],
            scorers: [{ name: "exact_match" }],
            source_prompt: name,
          },
        });
        setActive(res.playground);
        await listQuery.refetch();
        toast.success(`Loaded prompt “${name}” into playground`);
        router.replace("/evals?tab=playgrounds");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load prompt");
        router.replace("/evals?tab=playgrounds");
      }
    })();
  }, [searchParams, currentOrg?.id]);

  const dismissFromProduction = useCallback(() => {
    setFromProduction(null);
    clearFromProductionStorage();
  }, []);

  const createNew = async () => {
    if (!currentOrg?.id) return;
    setBusy(true);
    try {
      const res = await playgroundApi.create(currentOrg.id, {
        name: `Playground ${new Date().toLocaleString()}`,
        config: {
          tasks: [
            { id: "task_a", label: "A", system: "", user: "{{user}}", model: "t1", tools: [] },
            { id: "task_b", label: "B", system: "", user: "{{user}}", model: "t2", tools: [] },
          ],
          scorers: [{ name: "exact_match" }],
        },
      });
      setActive(res.playground);
      await load();
      toast.success("Playground saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const bindDataset = async (datasetId: string) => {
    if (!currentOrg?.id || !active) return;
    const cfg = { ...(active.config || {}), dataset_id: datasetId || null };
    const res = await playgroundApi.patch(currentOrg.id, active.id, { config: cfg });
    setActive(res.playground);
    if (!datasetId) setRun(null);
    toast.success(datasetId ? "Dataset bound" : "Dataset unbound");
  };

  /** E-04: create + bind without leaving Playground tab (upload stays on Datasets). */
  const createAndBindDataset = async () => {
    if (!currentOrg?.id || !active) return;
    setBusy(true);
    try {
      const created = await datasetsApi.create(currentOrg.id, {
        name: `Dataset ${new Date().toLocaleString()}`,
        description: "Created from Playground",
      });
      const cfg = { ...(active.config || {}), dataset_id: created.id };
      const res = await playgroundApi.patch(currentOrg.id, active.id, { config: cfg });
      setActive(res.playground);
      await load();
      toast.success("Dataset created and bound");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create dataset failed");
    } finally {
      setBusy(false);
    }
  };

  const runMatrix = async () => {
    if (!currentOrg?.id || !active) return;
    setBusy(true);
    try {
      let datasetRows: Array<Record<string, unknown>> | undefined;
      const dsId = active.config?.dataset_id as string | undefined;
      if (dsId) {
        const detail = await datasetsApi.get(currentOrg.id, dsId);
        datasetRows = (detail.rows || []).slice(0, 20).map((r) => ({
          id: r.id,
          input: String(r.values?.input ?? r.values?.prompt ?? userPrompt),
          expected_output: String(r.values?.expected_output ?? r.values?.expected ?? ""),
        }));
      }
      const res = await playgroundApi.runPersisted(currentOrg.id, active.id, {
        params: { user: userPrompt },
        dataset_rows: datasetRows,
      });
      setRun(res.run as RunMatrix);
      // U20_TOAST: playground.run + playground.compare (multi-prompt run is the compare mutation)
      toast.success(
        datasetRows?.length
          ? `Compare complete · $${Number(res.run.cost_usd ?? 0).toFixed(4)}`
          : `Run complete · $${Number(res.run.cost_usd ?? 0).toFixed(4)}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    if (!currentOrg?.id || !active) return;
    const dsId = active.config?.dataset_id as string | undefined;
    if (!dsId) {
      toast.error("Bind a dataset before promoting to experiment");
      return;
    }
    try {
      const res = await playgroundApi.promoteExperiment(currentOrg.id, active.id, {
        dataset_id: dsId,
      });
      const expId = String(res.experiment?.id || "");
      toast.success("Promoted to experiment");
      router.push(expId ? experimentHref(expId) : experimentHref());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Promote failed");
    }
  };

  const boundDatasetId = (active?.config?.dataset_id as string) || "";
  const canPromote = Boolean(boundDatasetId);
  const canRun = Boolean(userPrompt.trim() || boundDatasetId);
  const runDisabledReason = !canRun
    ? "Enter a user message or bind a dataset to run"
    : undefined;
  const promoteDisabledReason = !canPromote
    ? "Bind a dataset before promoting to an experiment"
    : undefined;

  const activeIndex = active
    ? playgrounds.findIndex((p) => p.id === active.id)
    : -1;
  useListKeyboardNav(
    playgrounds.length,
    activeIndex >= 0 ? activeIndex : 0,
    (idx) => {
      const row = playgrounds[idx];
      if (row) setActive(row);
    },
    playgrounds.length > 0,
  );

  return {
    currentOrg,
    embedded,
    loading,
    listError,
    playgrounds,
    datasets,
    load,
    active,
    setActive,
    userPrompt,
    setUserPrompt,
    busy,
    run,
    fromProduction,
    dismissFromProduction,
    createNew,
    bindDataset,
    createAndBindDataset,
    runMatrix,
    promote,
    boundDatasetId,
    canPromote,
    canRun,
    runDisabledReason,
    promoteDisabledReason,
  };
}
