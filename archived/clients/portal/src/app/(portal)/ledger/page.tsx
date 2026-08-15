"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { AgentScopeFilter, EmptyState } from "@/lab/lab-ui";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import { patchPortalCatalog } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi, ledgerApi, type LedgerSummaryRow } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  LoadingFallback,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Ledger (`src/eden/kb/ledger/`) — institutional memory injected into prompts. */

function agentLabel(agents: { id: string; name: string }[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

function LedgerInner() {
  const searchParams = useSearchParams();
  const paramAgent = searchParams.get("agent") ?? searchParams.get("id");

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

  const listQuery = useOrgQuery(
    queryKeys.ledger.list(orgId),
    orgId,
    () => ledgerApi.list(orgId!),
    SHELL_QUERY,
  );
  const ledgers = listQuery.data ?? [];

  const [selectedAgent, setSelectedAgent] = useState<string>(() => paramAgent ?? "");
  useEffect(() => {
    if (paramAgent) setSelectedAgent(paramAgent);
  }, [paramAgent]);

  const scoped = useMemo(() => {
    if (agentId === "all") return ledgers;
    return ledgers.filter((l) => l.agent_id === agentId);
  }, [ledgers, agentId]);

  useEffect(() => {
    if (listQuery.isLoading) return;
    if (scoped.length === 0) return;
    if (scoped.some((l) => l.agent_id === selectedAgent)) return;
    setSelectedAgent(scoped[0]!.agent_id);

  }, [scoped, listQuery.isLoading]);

  const selectedSummary: LedgerSummaryRow | null =
    scoped.find((l) => l.agent_id === selectedAgent) ?? scoped[0] ?? null;
  const activeAgentId = selectedSummary?.agent_id ?? selectedAgent;

  const detailQuery = useOrgQuery(
    queryKeys.ledger.detail(orgId, activeAgentId),
    orgId,
    () => ledgerApi.get(orgId!, activeAgentId),
    { ...SHELL_QUERY, enabled: Boolean(orgId && activeAgentId) },
  );

  const selectAgent = useCallback(
    (id: string) => {
      setSelectedAgent(id);
      patchQuery({ agent: id });
    },
    [patchQuery],
  );

  const regenerateMutation = useOrgMutation(
    () => ledgerApi.regenerate(orgId!, activeAgentId),
    {
      invalidateKeys: [queryKeys.ledger.all],
      onSuccess: () => pushToast({ title: "Ledger regenerated", tone: "ok" }),
      onError: (err) =>
        pushToast({
          title: "Regenerate failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  const toggleMutation = useOrgMutation(
    (enabled: boolean) =>
      ledgerApi.setConfig(orgId!, activeAgentId, {
        enabled,
        max_tokens: detailQuery.data?.config?.max_tokens ?? 800,
      }),
    {
      invalidateKeys: [queryKeys.ledger.all],
      onSuccess: () => pushToast({ title: "Ledger config saved", tone: "ok" }),
      onError: (err) =>
        pushToast({
          title: "Save failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Ledger"
        message="Select a workspace to view the ledger."
      />
    );
  }

  if (listQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Ledger" />
        <QueryLoadingPanel label="Loading ledger…" />
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Ledger" />
        <QueryErrorPanel
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
        />
      </div>
    );
  }

  const enabledCount = ledgers.filter((l) => l.inject_enabled).length;
  const ledger = detailQuery.data?.ledger ?? null;
  const config = detailQuery.data?.config ?? null;

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Ledger"
        meta={
          <span className="type-meta">
            Institutional memory injected into prompts · {ledgers.length}
            {enabledCount > 0 ? ` · ${enabledCount} live` : ""}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[22rem] lg:shrink-0 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
            <AgentScopeFilter value={agentId} onChange={setAgentId} />
          </div>

          {scoped.length === 0 ? (
            <EmptyState
              title={agentId !== "all" ? "No ledger for this agent" : "No ledgers yet"}
              body="A ledger builds automatically once an agent has enough resolved issues and drift history to draw institutional-memory entries from."
            />
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {scoped.map((l) => {
                const active = l.agent_id === activeAgentId;
                return (
                  <li key={l.agent_id}>
                    <button
                      type="button"
                      onClick={() => selectAgent(l.agent_id)}
                      className={cn(
                        "flex w-full flex-col gap-1 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors sm:px-5",
                        active ? "bg-[var(--accent-muted)]" : "hover:bg-[var(--bg-inset)]",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusChip tone={l.inject_enabled ? "live" : "neutral"}>
                          {l.inject_enabled ? "injecting" : "draft"}
                        </StatusChip>
                        <span className="type-meta">v{l.version}</span>
                      </div>
                      <span className="type-ui truncate text-[var(--text)]">
                        {agentLabel(agents, l.agent_id)}
                      </span>
                      <span className="type-meta">
                        {l.updated_at ? `Updated ${formatRelativeTime(l.updated_at)}` : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!activeAgentId ? (
            <EmptyState title="Select an agent" compact />
          ) : detailQuery.isLoading ? (
            <QueryLoadingPanel label="Loading ledger…" />
          ) : detailQuery.isError ? (
            <QueryErrorPanel
              error={detailQuery.error}
              onRetry={() => void detailQuery.refetch()}
            />
          ) : !ledger ? (
            <EmptyState
              title="No ledger entries yet"
              body="This agent has not accrued enough resolved-issue evidence to generate ledger entries."
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="type-title text-[var(--text)]">
                    {agentLabel(agents, activeAgentId)}
                  </h2>
                  <p className="type-meta mt-1">
                    Version {ledger.version} · {ledger.entries.length} entries
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip tone={ledger.inject_enabled ? "live" : "neutral"}>
                    {ledger.inject_enabled ? "injecting" : "draft"}
                  </StatusChip>
                  <button
                    type="button"
                    className="ds-btn ds-btn-secondary ds-btn-sm"
                    disabled={toggleMutation.isPending}
                    onClick={() => toggleMutation.mutate(!ledger.inject_enabled)}
                  >
                    {ledger.inject_enabled ? "Disable injection" : "Enable injection"}
                  </button>
                  <button
                    type="button"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                    disabled={regenerateMutation.isPending}
                    onClick={() => regenerateMutation.mutate()}
                  >
                    Regenerate
                  </button>
                </div>
              </div>

              {config ? (
                <p className="type-meta mt-3">Max tokens · {config.max_tokens}</p>
              ) : null}

              <section className="mt-5 space-y-3">
                <h3 className="type-ui text-[var(--text-secondary)]">Entries</h3>
                {ledger.entries.length === 0 ? (
                  <p className="type-body text-[var(--text-faint)]">
                    No entries yet.
                  </p>
                ) : (
                  ledger.entries.map((e) => (
                    <div key={e.id} className="ds-panel-muted p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="type-ui text-[var(--text)]">{e.chapter}</span>
                        <span className="type-meta">
                          weight {(e.weight ?? 1).toFixed(1)}
                          {e.created_at ? ` · ${formatRelativeTime(e.created_at)}` : ""}
                        </span>
                      </div>
                      <p className="type-body mt-2 whitespace-pre-wrap break-words">
                        {e.text}
                      </p>
                      {e.citations && e.citations.length > 0 ? (
                        <p className="type-meta mt-2">
                          Citations · {e.citations.join(", ")}
                        </p>
                      ) : null}
                    </div>
                  ))
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LedgerPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Ledger" />
          <LoadingFallback label="Loading ledger…" />
        </div>
      }
    >
      <LedgerInner />
    </Suspense>
  );
}
