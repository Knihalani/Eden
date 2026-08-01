"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { ConnectRepoPanel } from "@/components/agents/ConnectRepoPanel";
import {
  clearStoredInstallAgentId,
  readStoredInstallAgentId,
} from "@/lib/github-install";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { catalogAgents, patchPortalCatalog } from "@/lib/portal-catalog";
import { SHELL_QUERY } from "@/lib/portal-query";
import { EmptyState } from "@/lab/lab-ui";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { QueryLoadingPanel } from "@/components/shell/query-error-panel";

function ConnectInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const agentFromQuery = searchParams.get("agent");
  const [agentId, setAgentId] = useState<string | null>(agentFromQuery);
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

  // GitHub callback drops ?agent= — restore from sessionStorage after install.
  useEffect(() => {
    if (agentFromQuery) {
      setAgentId(agentFromQuery);
      return;
    }
    const stored = readStoredInstallAgentId();
    if (!stored) return;
    setAgentId(stored);
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", stored);
    clearStoredInstallAgentId();
    router.replace(`/agents/connect?${params.toString()}`);
  }, [agentFromQuery, router, searchParams]);

  const agents = useMemo(() => {
    const live = agentsQuery.data;
    if (live && live.length > 0) return live;
    return catalogAgents();
  }, [agentsQuery.data]);

  const pickAgent = (id: string) => {
    setAgentId(id);
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", id);
    router.replace(`/agents/connect?${params.toString()}`);
  };

  return (
    <div className="ds-page">
      <PageHeader
        title="Connect repository"
        meta={
          <span className="type-meta">
            {agentId
              ? `Repo for ${agentId}`
              : "Pick an agent, then link its GitHub repo"}
          </span>
        }
        actions={
          <Link
            href={agentId ? `/agents?id=${encodeURIComponent(agentId)}` : "/agents"}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Back to Agents
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 py-6 sm:px-6">
        {!agentId ? (
          <div
            className="border border-[var(--line)] bg-[var(--bg)] p-5 sm:p-6"
            data-testid="connect-agent-picker"
          >
            <p className="type-ui">Select an agent</p>
            <p className="type-meta mt-1 max-w-xl">
              Each agent has its own PR target. Pick one, then connect the
              GitHub repo that holds that agent’s code.
            </p>
            {agentsQuery.isLoading && agents.length === 0 ? (
              <QueryLoadingPanel label="Loading agents…" />
            ) : agents.length === 0 ? (
              <EmptyState
                compact
                title="No agents registered"
                body={U20_EMPTY_COPY.agents}
                action={
                  <Link
                    href="/settings?mode=keys"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                  >
                    API keys
                  </Link>
                }
              />
            ) : (
              <ul className="mt-4 divide-y divide-[var(--line)] border border-[var(--line)]">
                {agents.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => pickAgent(a.id)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span className="min-w-0">
                        <span className="type-ui block truncate text-[var(--text)]">
                          {a.name}
                        </span>
                        <span className="type-meta block truncate">{a.id}</span>
                      </span>
                      <span className="type-meta shrink-0 text-[var(--accent)]">
                        Connect
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {agentsQuery.isError ? (
              <p className="type-meta mt-3 text-[var(--warning)]" role="status">
                Couldn’t refresh agents from the server. Showing catalog
                fallback if available.
              </p>
            ) : null}
          </div>
        ) : (
          <ConnectRepoPanel agentId={agentId} />
        )}
      </div>
    </div>
  );
}

export default function AgentsConnectPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Connect repository" />
        </div>
      }
    >
      <ConnectInner />
    </Suspense>
  );
}
