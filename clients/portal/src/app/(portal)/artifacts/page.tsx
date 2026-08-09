"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { AgentScopeFilter, EmptyState, FilterChips } from "@/lab/lab-ui";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import { patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi, artifactsApi, type ArtifactMode, type ArtifactRow } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { cn } from "@/lib/utils";
import { TeamContextPanel } from "@/components/artifacts/team-context-panel";
import { DemotionActivityPanel } from "@/components/artifacts/demotion-activity-panel";

/** F39 Nudges ("Artifacts") — evidence-gated runtime prompt fixes. */

function modeTone(mode: string): "ok" | "fail" | "neutral" | "live" {
  if (mode === "promoted") return "ok";
  if (mode === "archived") return "neutral";
  return "live"; // shadow
}

function agentLabel(agents: { id: string; name: string }[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

function ArtifactsInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const paramAgent = searchParams.get("agent");
  const paramMode = searchParams.get("mode");

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
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
  const agents = agentsQuery.data ?? [];

  const [modeFilter, setModeFilter] = useState<ArtifactMode | "all">(
    () => (paramMode as ArtifactMode | null) ?? "all",
  );
  const [selectedId, setSelectedId] = useState<string>(() => paramId ?? "");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) setAgentId(paramAgent);
    setModeFilter((paramMode as ArtifactMode | null) ?? "all");
    if (paramId) setSelectedId(paramId);

  }, [paramAgent, paramMode, paramId]);

  const listQuery = useOrgQuery(
    queryKeys.artifacts.list(orgId, {
      agentId: agentId === "all" ? undefined : agentId,
      mode: modeFilter === "all" ? undefined : modeFilter,
    }),
    orgId,
    () =>
      artifactsApi.list(orgId!, {
        agentId: agentId === "all" ? undefined : agentId,
        mode: modeFilter === "all" ? undefined : modeFilter,
      }),
    SHELL_QUERY,
  );
  const artifacts = listQuery.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.content.toLowerCase().includes(q) ||
        agentLabel(agents, a.agent_id).toLowerCase().includes(q),
    );
  }, [artifacts, query, agents]);

  useEffect(() => {
    if (listQuery.isLoading) return;
    if (filtered.length === 0) return;
    if (filtered.some((a) => a.id === selectedId)) return;
    setSelectedId(filtered[0]!.id);

  }, [filtered, listQuery.isLoading]);

  const selected: ArtifactRow | null =
    filtered.find((a) => a.id === selectedId) ?? filtered[0] ?? null;

  const selectArtifact = useCallback(
    (id: string) => {
      setSelectedId(id);
      patchQuery({ id });
    },
    [patchQuery],
  );

  const changeMode = useCallback(
    (next: ArtifactMode | "all") => {
      setModeFilter(next);
      patchQuery({ mode: next === "all" ? null : next });
    },
    [patchQuery],
  );

  const promoteMutation = useOrgMutation(
    (artifactId: string) => artifactsApi.promote(orgId!, artifactId),
    {
      invalidateKeys: [queryKeys.artifacts.all],
      onSuccess: () => pushToast({ title: "Promoted", tone: "ok" }),
      onError: (err) =>
        pushToast({
          title: "Promote failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  const archiveMutation = useOrgMutation(
    (artifactId: string) => artifactsApi.archive(orgId!, artifactId),
    {
      invalidateKeys: [queryKeys.artifacts.all],
      onSuccess: () => pushToast({ title: "Archived", tone: "ok" }),
      onError: (err) =>
        pushToast({
          title: "Archive failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  const modeOptions: { id: ArtifactMode | "all"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "shadow", label: "Shadow" },
    { id: "promoted", label: "Promoted" },
    { id: "archived", label: "Archived" },
  ];

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Artifacts"
        message="Select a workspace to view artifacts."
      />
    );
  }

  if (listQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Artifacts" />
        <QueryLoadingPanel label="Loading artifacts…" />
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Artifacts" />
        <QueryErrorPanel
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
        />
      </div>
    );
  }

  const promotedCount = artifacts.filter((a) => a.mode === "promoted").length;

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Artifacts"
        meta={
          <span className="type-meta">
            Runtime prompt fixes · {artifacts.length}
            {promotedCount > 0 ? ` · ${promotedCount} promoted` : ""}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[22rem] lg:shrink-0 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
            <label className="relative min-w-[10rem] flex-1">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search artifacts…"
                className="ds-input w-full !py-1.5"
                aria-label="Search artifacts"
              />
            </label>
            <AgentScopeFilter value={agentId} onChange={setAgentId} />
          </div>
          <div className="border-b border-[var(--line)] px-4 py-2 sm:px-5">
            <FilterChips value={modeFilter} onChange={changeMode} options={modeOptions} />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title={query || agentId !== "all" || modeFilter !== "all" ? "No matches" : "No artifacts yet"}
              body={
                query || agentId !== "all" || modeFilter !== "all"
                  ? undefined
                  : "Artifacts are evidence-gated runtime prompt fixes authored from Issues. They start in shadow mode and promote once evidence clears the gate."
              }
              action={
                query || agentId !== "all" || modeFilter !== "all" ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={() => {
                      setQuery("");
                      setAgentId("all");
                      changeMode("all");
                    }}
                  >
                    Clear filters
                  </button>
                ) : (
                  <Link href="/issues" className="ds-btn ds-btn-primary ds-btn-sm">
                    Review issues
                  </Link>
                )
              }
            />
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {filtered.map((a) => {
                const active = a.id === selected?.id;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => selectArtifact(a.id)}
                      className={cn(
                        "flex w-full flex-col gap-1 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors sm:px-5",
                        active ? "bg-[var(--accent-muted)]" : "hover:bg-[var(--bg-inset)]",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusChip tone={modeTone(a.mode)}>{a.mode}</StatusChip>
                        <span className="type-meta">{a.action_type}</span>
                      </div>
                      <span className="type-ui truncate text-[var(--text)]">{a.name}</span>
                      <span className="type-meta">{agentLabel(agents, a.agent_id)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <EmptyState title="Select an artifact" compact />
              {agentId !== "all" ? (
                <>
                  <TeamContextPanel orgId={orgId} agentId={agentId} />
                  <DemotionActivityPanel orgId={orgId} agentId={agentId} />
                </>
              ) : (
                <DemotionActivityPanel orgId={orgId} />
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="type-title text-[var(--text)]">{selected.name}</h2>
                  <p className="type-meta mt-1">
                    {agentLabel(agents, selected.agent_id)} · {selected.action_type}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip tone={modeTone(selected.mode)}>{selected.mode}</StatusChip>
                  {selected.mode === "shadow" ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-primary ds-btn-sm"
                      disabled={promoteMutation.isPending}
                      onClick={() => promoteMutation.mutate(selected.id)}
                    >
                      Promote
                    </button>
                  ) : null}
                  {selected.mode !== "archived" ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-secondary ds-btn-sm"
                      disabled={archiveMutation.isPending}
                      onClick={() => archiveMutation.mutate(selected.id)}
                    >
                      Archive
                    </button>
                  ) : null}
                </div>
              </div>

              {selected.cost ? (
                <p className="type-meta mt-4">
                  Est. cost · {selected.cost.tokens ?? "—"} tokens
                  {typeof selected.cost.usd === "number"
                    ? ` · $${selected.cost.usd.toFixed(4)}`
                    : ""}
                </p>
              ) : null}

              <section className="mt-5">
                <h3 className="type-ui text-[var(--text-secondary)]">Content</h3>
                <pre className="ds-panel-muted mt-2 whitespace-pre-wrap break-words p-3 type-body">
                  {selected.content}
                </pre>
              </section>

              {selected.trigger && Object.keys(selected.trigger).length > 0 ? (
                <section className="mt-5">
                  <h3 className="type-ui text-[var(--text-secondary)]">Trigger</h3>
                  <pre className="ds-panel-muted mt-2 whitespace-pre-wrap break-words p-3 type-body">
                    {JSON.stringify(selected.trigger, null, 2)}
                  </pre>
                </section>
              ) : null}

              {selected.evidence && Object.keys(selected.evidence).length > 0 ? (
                <section className="mt-5">
                  <h3 className="type-ui text-[var(--text-secondary)]">Evidence</h3>
                  <pre className="ds-panel-muted mt-2 whitespace-pre-wrap break-words p-3 type-body">
                    {JSON.stringify(selected.evidence, null, 2)}
                  </pre>
                </section>
              ) : null}

              {selected.source_issue_id ? (
                <p className="type-meta mt-5">
                  Source ·{" "}
                  <Link
                    href={`/issues?id=${encodeURIComponent(selected.source_issue_id)}`}
                    className="underline"
                  >
                    Issue {selected.source_issue_id}
                  </Link>
                </p>
              ) : null}

              {agentId !== "all" ? (
                <TeamContextPanel orgId={orgId} agentId={agentId} />
              ) : null}

              <DemotionActivityPanel
                orgId={orgId}
                agentId={agentId !== "all" ? agentId : undefined}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ArtifactsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading artifacts…</p>
        </div>
      }
    >
      <ArtifactsInner />
    </Suspense>
  );
}
