"use client";

/**
 * Phase 3 — Agent detail page (client component).
 *
 * Converted from server component on 2026-06-22. The previous
 * version imported ``@/lib/api`` (a client-only module with
 * ``fetch``, ``AbortController``, the Clerk SDK refresh path, and
 * module-level state) directly into a server component, which
 * (a) bundled Clerk into the server bundle and (b) issued same-
 * origin proxy requests server-side where the Clerk session cookie
 * isn't attached to ``auth().getToken()`` — every data call
 * silently returned empty.
 *
 * Now: this file is a client component that reads the active org
 * from ``useOrg()`` (which already handles Clerk → Eden
 * resolution) and fetches via the same ``agentsApi`` client the
 * rest of the portal uses. Data is loaded via React Query so the
 * page can render the chrome immediately and show a loading
 * skeleton while the agent comes back.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import {
  Bot,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { agentsApi, ApiError } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageLoading } from "@/components/layout/page-content";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { tracesFilteredHref } from "@/lib/portal-cross-links";

function formatRelative(iso?: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const FRAMEWORK_BADGE: Record<string, string> = {
  langchain: "bg-[var(--accent-faint)] text-[var(--accent)]",
  "openai-agents": "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  raw: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  none: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
};

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-space-4">
      <span className="shrink-0 text-xs uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-sm text-[var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const agentQuery = useOrgQuery(
    queryKeys.agents.detail(orgId, agentId),
    orgId,
    () => agentsApi.get(orgId!, agentId),
    { enabled: Boolean(agentId) },
  );

  const agent = agentQuery.data ?? null;
  const loading = agentQuery.isLoading || agentQuery.isPending;
  const loadError = agentQuery.error?.message ?? null;
  const isNotFound =
    (agentQuery.error instanceof ApiError && agentQuery.error.status === 404) ||
    (typeof agentQuery.error === "object" &&
      agentQuery.error !== null &&
      "status" in agentQuery.error &&
      (agentQuery.error as { status: number }).status === 404);

  const isLive = agent?.last_seen_at
    ? Date.now() - new Date(agent.last_seen_at).getTime() < 1000 * 60 * 60 * 24
    : false;
  const repoHost = (() => {
    if (!agent?.repo_url) return null;
    try {
      return new URL(agent.repo_url).hostname.replace(/^www\./, "");
    } catch {
      return agent.repo_url;
    }
  })();

  if (!orgId) {
    return (
      <NoOrgState
        icon={Bot}
        feature="Agents"
        description="Select an organisation to view this agent."
      />
    );
  }

  if (!agentId) {
    return (
      <PageContent size="narrow" className="space-y-space-4">
        <EmptyState
          icon={Bot}
          title="Invalid agent"
          description="This URL is missing an agent id. Pick an agent from the list."
          size="lg"
          action={
            <Button asChild className="min-h-11">
              <Link href="/agents">Back to agents</Link>
            </Button>
          }
        />
      </PageContent>
    );
  }

  if (loading && !agent) {
    return <PageLoading size="wide" message="Loading agent…" />;
  }

  if (isNotFound) {
    return (
      <PageContent size="narrow" className="space-y-space-4">
        <EmptyState
          icon={Bot}
          title="Agent not found"
          description={`No agent with id ${agentId} exists in this organisation yet. It will appear once the agent first reports telemetry.`}
          size="lg"
          action={
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/agents">Back to agents</Link>
            </Button>
          }
        />
      </PageContent>
    );
  }

  if (loadError) {
    return (
      <PageContent size="narrow" className="space-y-space-4">
        <ErrorState
          title="Could not load agent"
          message={loadError}
          action={
            <Button
              type="button"
              onClick={() => void agentQuery.refetch()}
              disabled={loading}
              loading={loading}
              className="min-h-11"
            >
              Try again
            </Button>
          }
        />
      </PageContent>
    );
  }

  if (!agent) {
    return <PageLoading size="wide" message="Loading agent…" />;
  }

  const encodedId = encodeURIComponent(agentId);

  return (
    <PageContent size="wide" className="space-y-space-4" data-wave7-agents="detail-flat">
      <PageHeader
        title={agent.name ?? agentId}
        subtitle={
          <>
            <Link
              href="/agents"
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Agents
            </Link>
            {" · "}
            <span className="font-mono">{agentId}</span>
            {agent.repo_url && repoHost ? (
              <>
                {" · "}
                <a
                  href={agent.repo_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                >
                  {repoHost}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </>
            ) : null}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {agent.framework ? (
              <span
                className={`rounded px-2 py-1 text-xs font-medium uppercase tracking-wide ${
                  FRAMEWORK_BADGE[agent.framework] ?? FRAMEWORK_BADGE.none
                }`}
              >
                {agent.framework}
              </span>
            ) : null}
            {isLive ? (
              <span className="inline-flex items-center gap-1 rounded bg-[var(--terminal-faint)] px-2 py-1 text-xs font-medium uppercase tracking-wide text-[var(--terminal)]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--terminal)]" />
                live
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="min-h-11" aria-label="Related agent surfaces">
                  More
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel>Go to</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href={`/agents/${encodedId}/ledger`}>Ledger</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/agents/${encodedId}/artifacts`}>Artifacts</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/agents/${encodedId}/book`}>Agent Book</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/agents/${encodedId}/drift`}>Drift</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={tracesFilteredHref({ agent_id: agentId })}>Traces</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <div
        className="flex max-w-lg flex-col gap-space-3"
        data-testid="agent-detail-stats"
        data-wave10-agent-detail="completed"
        data-wave7-agents="flat-meta"
      >
        <DetailRow label="Last seen" value={formatRelative(agent.last_seen_at)} />
        <DetailRow label="Framework" value={agent.framework ?? "—"} />
        <DetailRow label="Repo" value={repoHost ?? "Not linked"} />
      </div>
    </PageContent>
  );
}
