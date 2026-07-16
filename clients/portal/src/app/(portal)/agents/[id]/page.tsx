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
 * rest of the portal uses. Data is loaded in a ``useEffect`` so
 * the page can render the chrome immediately and show a loading
 * skeleton while the agent list comes back.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { agentsApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageLoading } from "@/components/layout/page-content";

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

interface AgentRecord {
  agent_id: string;
  name?: string;
  framework?: string;
  last_seen_at?: string | null;
  repo_url?: string | null;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const agentsQuery = useOrgQuery(
    queryKeys.agents.list(orgId, { limit: 200 }),
    orgId,
    () => agentsApi.list(orgId!, { limit: 200 }),
  );

  const agent = useMemo(() => {
    const list = (agentsQuery.data?.agents ?? []) as AgentRecord[];
    return list.find((a) => a.agent_id === agentId) ?? null;
  }, [agentsQuery.data, agentId]);
  const loading = agentsQuery.isLoading;
  const loadError = agentsQuery.error?.message ?? null;

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

  if (loading && !agent) {
    return <PageLoading size="wide" message="Loading agent…" />;
  }

  if (loadError) {
    return (
      <PageContent size="narrow" className="space-y-4">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          All agents
        </Link>
        <ErrorState
          title="Could not load agent"
          message={loadError}
          action={
            <button
              type="button"
              onClick={() => void agentsQuery.refetch()}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              Try again
            </button>
          }
        />
      </PageContent>
    );
  }

  if (!agent) {
    return (
      <PageContent size="narrow" className="space-y-4">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          All agents
        </Link>
        <EmptyState
          icon={Bot}
          title="Agent not found"
          description={`No agent with id ${agentId} exists in this organisation yet. It will appear once the agent first reports telemetry.`}
          size="lg"
        />
      </PageContent>
    );
  }

  return (
    <PageContent size="wide">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        All agents
      </Link>

      <PageHeader
        eyebrow="Agent"
        title={agent?.name ?? agentId}
        icon={Bot}
        subtitle={
          <>
            <span className="font-mono">{agentId}</span>
            {agent?.repo_url && repoHost ? (
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
          <div className="flex items-center gap-2">
            {agent?.framework && (
              <span
                className={`text-[10px] font-medium uppercase tracking-wide px-2 py-1 rounded ${
                  FRAMEWORK_BADGE[agent.framework] ?? FRAMEWORK_BADGE.none
                }`}
              >
                {agent.framework}
              </span>
            )}
            {isLive && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-2 py-1 rounded bg-[var(--terminal-faint)] text-[var(--terminal)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--terminal)] animate-pulse" />
                live
              </span>
            )}
          </div>
        }
      />

      <Card className="p-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Stat
            icon={Clock}
            label="Last seen"
            value={formatRelative(agent?.last_seen_at)}
          />
          <Stat
            icon={Bot}
            label="Framework"
            value={agent?.framework ?? "—"}
          />
          <Stat
            icon={ExternalLink}
            label="Repo"
            value={repoHost ?? "Not linked"}
          />
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={`/agents/${encodeURIComponent(agentId)}/book`}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          Agent Book →
        </Link>
        <Link
          href={`/agents/${encodeURIComponent(agentId)}/drift`}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          Drift report →
        </Link>
      </div>
    </PageContent>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)] font-medium">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <p className="text-base font-semibold text-[var(--text-primary)] mt-1 tabular-nums">
        {value}
      </p>
    </div>
  );
}
