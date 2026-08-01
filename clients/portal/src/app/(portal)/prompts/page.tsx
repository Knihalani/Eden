"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  defaultPromptId,
  liveVersion,
  promptById,
  promptDetailToFixture,
  promptListRowToFixture,
  promptVersionId,
  promptsForAgent,
  versionNumberFromId,
  type PromptDetailTab,
  type PromptEnv,
  type PromptFixture,
  type PromptStatus,
} from "@/lab/fixtures/prompts";
import { catalogAgents } from "@/lib/portal-catalog";
import { AGENT_LIST } from "@/lab/fixtures/agents";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  parsePromptStatusFilter,
  parsePromptTab,
} from "@/lab/prompts/prompts-chrome";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { promptsV2Api } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { useLabToast } from "@/lab/lab-toast";

const promptsFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const PromptsListView = dynamic(
  () =>
    import("@/lab/prompts/prompts-list-view").then((m) => ({
      default: m.PromptsListView,
    })),
  { loading: () => promptsFallback },
);
const PromptsDetailView = dynamic(
  () =>
    import("@/lab/prompts/prompts-detail-view").then((m) => ({
      default: m.PromptsDetailView,
    })),
  { loading: () => promptsFallback },
);

function PromptsInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id") ?? searchParams.get("prompt");
  const paramAgent = searchParams.get("agent");
  const paramStatus = searchParams.get("status");
  const paramTab = searchParams.get("tab");
  const paramVersion = searchParams.get("version");

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();

  const listQuery = useOrgQuery(
    queryKeys.promptsV2.list(orgId),
    orgId,
    () => promptsV2Api.list(orgId!),
    SHELL_QUERY,
  );

  const [promptId, setPromptId] = useState(() => paramId ?? "");
  const [statusFilter, setStatusFilter] = useState<PromptStatus | "all">(() =>
    parsePromptStatusFilter(paramStatus),
  );
  const [tab, setTab] = useState<PromptDetailTab>(() =>
    parsePromptTab(paramTab),
  );
  const [versionId, setVersionId] = useState<string | null>(
    () => paramVersion,
  );
  const [draftBody, setDraftBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const detailQuery = useOrgQuery(
    queryKeys.promptsV2.detail(orgId, promptId),
    orgId,
    () => promptsV2Api.get(orgId!, promptId),
    { ...SHELL_QUERY, enabled: Boolean(orgId && promptId) },
  );
  const pinsQuery = useOrgQuery(
    queryKeys.promptsV2.pins(orgId, promptId),
    orgId,
    () => promptsV2Api.getPins(orgId!, promptId),
    { ...SHELL_QUERY, enabled: Boolean(orgId && promptId) },
  );

  const listCatalog = useMemo(
    () => (listQuery.data ?? []).map(promptListRowToFixture),
    [listQuery.data],
  );

  const hydrated = useMemo(() => {
    if (!detailQuery.data) return null;
    return promptDetailToFixture(
      detailQuery.data,
      pinsQuery.data?.pins ?? {},
    );
  }, [detailQuery.data, pinsQuery.data?.pins]);

  const catalog = useMemo((): PromptFixture[] => {
    if (!hydrated) return listCatalog;
    const idx = listCatalog.findIndex((p) => p.id === hydrated.id);
    if (idx < 0) return [hydrated, ...listCatalog];
    const next = listCatalog.slice();
    next[idx] = hydrated;
    return next;
  }, [listCatalog, hydrated]);

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) setAgentId(paramAgent);
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    if (paramId) setPromptId(paramId);
    setStatusFilter(parsePromptStatusFilter(paramStatus));
    setTab(parsePromptTab(paramTab));
    if (paramVersion) setVersionId(paramVersion);
  }, [paramId, paramStatus, paramTab, paramVersion]);

  const scoped = useMemo(
    () => promptsForAgent(agentId, catalog),
    [agentId, catalog],
  );

  useEffect(() => {
    if (listQuery.isLoading) return;
    if (scoped.length === 0) {
      if (promptId) setPromptId("");
      return;
    }
    if (scoped.some((p) => p.id === promptId)) return;
    const next = defaultPromptId(agentId, catalog);
    setPromptId(next);
    patchQuery({ id: next || null });
  }, [
    agentId,
    promptId,
    scoped,
    catalog,
    patchQuery,
    listQuery.isLoading,
  ]);

  const prompt = useMemo(() => {
    return hydrated ?? promptById(promptId, catalog) ?? scoped[0] ?? null;
  }, [hydrated, promptId, catalog, scoped]);

  const scopeCounts = useMemo(() => {
    const map: Record<string, number> = { all: catalog.length };
    const agents = catalogAgents().length > 0 ? catalogAgents() : AGENT_LIST;
    for (const a of agents) {
      map[a.id] = promptsForAgent(a.id, catalog).length;
    }
    return map;
  }, [catalog]);

  const invalidateList = useCallback(() => {
    if (!orgId) return Promise.resolve();
    return queryClient.invalidateQueries({
      queryKey: queryKeys.promptsV2.list(orgId),
    });
  }, [orgId, queryClient]);

  const invalidateDetail = useCallback(() => {
    if (!orgId || !promptId) return Promise.resolve();
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.promptsV2.detail(orgId, promptId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.promptsV2.pins(orgId, promptId),
      }),
    ]);
  }, [orgId, promptId, queryClient]);

  const selectPrompt = useCallback(
    (id: string) => {
      setPromptId(id);
      setNotice(null);
      setVersionId(null);
      patchQuery({ id, version: null });
    },
    [patchQuery],
  );

  const changeStatus = useCallback(
    (next: PromptStatus | "all") => {
      setStatusFilter(next);
      patchQuery({ status: next === "all" ? null : next });
    },
    [patchQuery],
  );

  const changeTab = useCallback(
    (next: PromptDetailTab) => {
      setTab(next);
      patchQuery({ tab: next === "editor" ? null : next });
    },
    [patchQuery],
  );

  const changeVersion = useCallback(
    (id: string) => {
      setVersionId(id);
      const p = hydrated ?? promptById(promptId, catalog);
      const v = p?.versions.find((x) => x.id === id);
      if (v) setDraftBody(v.body);
      patchQuery({ version: id });
    },
    [promptId, catalog, hydrated, patchQuery],
  );

  // Load editor body when prompt or version changes (not on every keystroke).
  useEffect(() => {
    if (!prompt) {
      setDraftBody("");
      return;
    }
    const v =
      (versionId
        ? prompt.versions.find((x) => x.id === versionId)
        : undefined) ??
      liveVersion(prompt) ??
      prompt.versions[0];
    if (!v) return;
    if (versionId !== v.id) setVersionId(v.id);
    setDraftBody(v.body);
     
  }, [prompt?.id, versionId, prompt?.versions[0]?.id]);

  const handleSaveDraft = useCallback(async () => {
    if (!prompt || !orgId) return;
    const apiVersions = detailQuery.data?.versions ?? [];
    const selectedNum = versionId
      ? (() => {
          try {
            return versionNumberFromId(versionId);
          } catch {
            return null;
          }
        })()
      : null;
    const selectedApi =
      (selectedNum != null
        ? apiVersions.find((v) => v.version === selectedNum)
        : undefined) ??
      [...apiVersions].sort((a, b) => b.version - a.version)[0];
    const model = (selectedApi?.model || "").trim();
    if (!model) {
      setNotice("Pick a model on the version before saving");
      return;
    }

    try {
      await promptsV2Api.createVersion(orgId, prompt.name, {
        template: draftBody,
        model,
        change_note: "Saved from portal",
      });
      await Promise.all([invalidateDetail(), invalidateList()]);
      const refreshed = await detailQuery.refetch();
      const newest = [...(refreshed.data?.versions ?? [])].sort(
        (a, b) => b.version - a.version,
      )[0];
      if (newest) {
        const newId = promptVersionId(prompt.name, newest.version);
        setVersionId(newId);
        setNotice("Saved new draft version");
        setTab("versions");
        patchQuery({ tab: "versions", version: newId });
      } else {
        setNotice("Saved new draft version");
        setTab("versions");
        patchQuery({ tab: "versions" });
      }
    } catch (err) {
      pushToast({
        title: "Save failed",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "fail",
      });
    }
  }, [
    prompt,
    orgId,
    detailQuery,
    versionId,
    draftBody,
    invalidateDetail,
    invalidateList,
    patchQuery,
    pushToast,
  ]);

  const handlePin = useCallback(
    async (vid: string, env: PromptEnv) => {
      if (!prompt || !orgId) return;
      try {
        const version = versionNumberFromId(vid);
        await promptsV2Api.putPin(orgId, prompt.name, env, version);
        await invalidateDetail();
        setNotice(`Pinned to ${env}`);
      } catch (err) {
        pushToast({
          title: "Pin failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      }
    },
    [prompt, orgId, invalidateDetail, pushToast],
  );

  const handleRollback = useCallback(async () => {
    if (!prompt || !orgId) return;
    try {
      await promptsV2Api.rollback(orgId, prompt.name, "prod");
      await Promise.all([invalidateDetail(), invalidateList()]);
      setNotice("Prod rolled back to previous version");
      setTab("deploy");
      patchQuery({ tab: "deploy" });
    } catch (err) {
      pushToast({
        title: "Rollback failed",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "fail",
      });
    }
  }, [prompt, orgId, invalidateDetail, invalidateList, patchQuery, pushToast]);

  const handleNew = useCallback(async () => {
    if (!orgId) return;
    const name = `new-prompt-${Date.now().toString(36)}`;
    try {
      const res = await promptsV2Api.create(orgId, { name });
      await invalidateList();
      const createdName = res.data?.name ?? name;
      setPromptId(createdName);
      setVersionId(null);
      setDraftBody("");
      setTab("editor");
      setNotice("Draft created — edit and save");
      patchQuery({ id: createdName, tab: null, version: null });
    } catch (err) {
      pushToast({
        title: "Create failed",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "fail",
      });
    }
  }, [orgId, invalidateList, patchQuery, pushToast]);

  const liveCount = scoped.filter((p) => p.status === "live").length;
  const detailLoading =
    Boolean(promptId) &&
    (detailQuery.isLoading || (detailQuery.isFetching && !detailQuery.data));

  if (listQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Prompts" />
        <QueryLoadingPanel label="Loading prompts…" />
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Prompts" />
        <QueryErrorPanel
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Prompts"
        meta={
          <span className="type-meta">
            Registry · versions · env pins · {scoped.length} · {liveCount} live
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[22rem] lg:shrink-0 lg:border-b-0 lg:border-r">
          <PromptsListView
            prompts={scoped}
            activeId={prompt?.id ?? null}
            query={query}
            onQueryChange={setQuery}
            agentId={agentId}
            onAgentChange={setAgentId}
            statusFilter={statusFilter}
            onStatusFilter={changeStatus}
            onSelect={selectPrompt}
            onNew={handleNew}
            counts={scopeCounts}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detailLoading ? (
            <QueryLoadingPanel label="Loading prompt…" />
          ) : detailQuery.isError && promptId ? (
            <QueryErrorPanel
              error={detailQuery.error}
              onRetry={() => {
                void detailQuery.refetch();
                void pinsQuery.refetch();
              }}
            />
          ) : (
            <PromptsDetailView
              prompt={prompt}
              tab={tab}
              versionId={versionId}
              draftBody={draftBody}
              notice={notice}
              onTab={changeTab}
              onVersion={changeVersion}
              onDraftChange={setDraftBody}
              onSaveDraft={handleSaveDraft}
              onPin={handlePin}
              onRollback={handleRollback}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function PromptsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading prompts…</p>
        </div>
      }
    >
      <PromptsInner />
    </Suspense>
  );
}
