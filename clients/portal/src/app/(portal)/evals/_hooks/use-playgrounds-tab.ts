"use client";

import { useEffect, useMemo, useState } from "react";
import {
  playgroundApi,
  type PersistedPlayground,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import type { PlaygroundEditorValue } from "@/components/evals/playground-editor";
import { useEvalsUrlState } from "./use-evals-url-state";

function configToEditor(config: Record<string, unknown> | undefined): PlaygroundEditorValue {
  const tasks = Array.isArray(config?.tasks) ? config.tasks : [];
  const task0 =
    tasks[0] && typeof tasks[0] === "object"
      ? (tasks[0] as Record<string, unknown>)
      : {};
  return {
    system: String(task0.system ?? config?.system ?? ""),
    user: String(task0.user ?? config?.user ?? ""),
    model: String(task0.model ?? config?.model ?? "gpt-4o-mini"),
  };
}

function applyEditorToConfig(
  config: Record<string, unknown> | undefined,
  editor: PlaygroundEditorValue,
): Record<string, unknown> {
  const base = { ...(config ?? {}) };
  const tasks = Array.isArray(base.tasks)
    ? [...(base.tasks as Array<Record<string, unknown>>)]
    : [{ id: "task_a", label: "A", tools: [] }];
  const first = { ...(tasks[0] ?? { id: "task_a", label: "A", tools: [] }) };
  first.system = editor.system;
  first.user = editor.user;
  first.model = editor.model;
  tasks[0] = first;
  base.tasks = tasks;
  base.system = editor.system;
  base.user = editor.user;
  base.model = editor.model;
  return base;
}

export function usePlaygroundsTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState, clearSelection } = useEvalsUrlState();
  const playgroundId = state.playgroundId;

  const listQuery = useOrgQuery(
    queryKeys.playgrounds.list(orgId),
    orgId,
    () => playgroundApi.list(orgId!),
  );

  const playgrounds: PersistedPlayground[] = useMemo(
    () => listQuery.data?.playgrounds ?? [],
    [listQuery.data],
  );

  const detailQuery = useOrgQuery(
    queryKeys.playgrounds.detail(orgId, playgroundId ?? ""),
    orgId,
    () => playgroundApi.get(orgId!, playgroundId!),
    { enabled: Boolean(playgroundId) },
  );

  const selected: PersistedPlayground | null = useMemo(() => {
    if (!playgroundId) return null;
    return (
      detailQuery.data?.playground ??
      playgrounds.find((p) => p.id === playgroundId) ??
      null
    );
  }, [playgroundId, detailQuery.data, playgrounds]);

  const [draft, setDraft] = useState<PlaygroundEditorValue>({
    system: "",
    user: "",
    model: "gpt-4o-mini",
  });
  const [baseline, setBaseline] = useState<PlaygroundEditorValue | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!selected) {
      setDraft({ system: "", user: "", model: "gpt-4o-mini" });
      setBaseline(null);
      setLastRun(null);
      return;
    }
    const next = configToEditor(selected.config);
    setDraft(next);
    setBaseline(next);
    setLastRun(null);
  }, [selected?.id, selected?.updated_at]);

  const dirty =
    baseline != null &&
    (draft.system !== baseline.system ||
      draft.user !== baseline.user ||
      draft.model !== baseline.model);

  const patchMutation = useOrgMutation(
    (vars: { name?: string; config?: Record<string, unknown> }) =>
      playgroundApi.patch(orgId!, playgroundId!, vars),
    {
      invalidateKeys: [
        queryKeys.playgrounds.list(orgId),
        queryKeys.playgrounds.detail(orgId, playgroundId ?? ""),
      ],
      onSuccess: (res) => {
        const next = configToEditor(res.playground.config);
        setDraft(next);
        setBaseline(next);
        toast.success("Playground saved");
      },
      onError: (e) => toast.error(e.message || "Save failed"),
    },
  );

  const runMutation = useOrgMutation(
    () =>
      playgroundApi.runPersisted(orgId!, playgroundId!, {
        params: { user: draft.user },
      }),
    {
      onSuccess: (res) => {
        setLastRun(res.run ?? null);
        toast.success("Run complete");
      },
      onError: (e) => toast.error(e.message || "Run failed"),
    },
  );

  const promoteMutation = useOrgMutation(
    () => {
      const datasetId =
        typeof selected?.config?.dataset_id === "string"
          ? selected.config.dataset_id
          : undefined;
      return playgroundApi.promoteExperiment(orgId!, playgroundId!, {
        dataset_id: datasetId,
      });
    },
    {
      invalidateKeys: [queryKeys.offlineExperiments.all, queryKeys.playgrounds.all],
      onSuccess: (res) => {
        const expId = String(res.experiment?.id ?? "");
        toast.success("Promoted to experiment");
        setState({
          tab: "experiments",
          experimentId: expId || undefined,
          playgroundId: undefined,
        });
      },
      onError: (e) => toast.error(e.message || "Promote failed"),
    },
  );

  const createMutation = useOrgMutation(
    () =>
      playgroundApi.create(orgId!, {
        name: `Playground ${new Date().toLocaleString()}`,
        config: {
          tasks: [
            {
              id: "task_a",
              label: "A",
              system: "",
              user: "{{user}}",
              model: "gpt-4o-mini",
              tools: [],
            },
          ],
          scorers: [{ name: "exact_match" }],
        },
      }),
    {
      invalidateKeys: [queryKeys.playgrounds.all],
      onSuccess: (res) => {
        toast.success("Playground created");
        setState({
          tab: "playgrounds",
          playgroundId: res.playground.id,
        });
      },
      onError: (e) => toast.error(e.message || "Create failed"),
    },
  );

  function selectPlayground(id: string) {
    setState({ playgroundId: id, tab: "playgrounds" });
  }

  function clearPlaygroundSelection() {
    clearSelection();
  }

  async function saveDraft() {
    if (!selected || !orgId || !playgroundId) return;
    await patchMutation.mutateAsync({
      config: applyEditorToConfig(selected.config, draft),
    });
  }

  async function runPersisted() {
    if (dirty) await saveDraft();
    await runMutation.mutateAsync();
  }

  async function promoteExperiment() {
    if (dirty) await saveDraft();
    await promoteMutation.mutateAsync();
  }

  return {
    orgId,
    state,
    setState,
    listQuery,
    playgrounds,
    playgroundId,
    selected,
    detailQuery,
    draft,
    setDraft,
    dirty,
    lastRun,
    selectPlayground,
    clearPlaygroundSelection,
    saveDraft,
    runPersisted,
    promoteExperiment,
    createMutation,
    patchMutation,
    runMutation,
    promoteMutation,
  };
}

export type PlaygroundsTabState = ReturnType<typeof usePlaygroundsTab>;
