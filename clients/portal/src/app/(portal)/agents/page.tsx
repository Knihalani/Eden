/** Phase 3 — Agents list page (client-rendered for live filtering & refresh). */

"use client";

import { PageHeader } from "@/components/layout/page-header";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { CoreResourcePage, CrossLinkBar } from "@/components/portal-os";
import {
  Bot,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Filter,
  Clock,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryTab } from "@/hooks/use-query-tab";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { agentsApi, type AgentSummary } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useState, useMemo, Suspense } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

const AGENT_TABS = ["agents", "fleet"] as const;
const FleetView = dynamic(() => import("@/app/(portal)/fleet/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  ),
});

const PAGE_SIZE = 100;

const FRAMEWORK_BADGE: Record<string, string> = {
  langchain: "bg-[var(--accent-faint)] text-[var(--accent)]",
  "openai-agents": "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  raw: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  none: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
};

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

export default function AgentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <AgentsPageInner />
    </Suspense>
  );
}

function AgentsPageInner() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const canLinkRepo = hasPermission("integrations:write");
  // API key create/revoke is owner/admin only (settings:edit). Members
  // and viewers must not get a primary "API keys" first-run CTA.
  const canManageKeys = hasPermission("settings:edit");
  const orgId = currentOrg?.id ?? null;
  const [tab, setTab] = useQueryTab("tab", AGENT_TABS, "agents");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [search, setSearch] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("");

  const agentsQuery = useOrgQuery(
    queryKeys.agents.list(orgId, { limit }),
    orgId,
    () => agentsApi.list(orgId!, { limit }),
  );

  const agents = agentsQuery.data?.agents ?? [];
  const total = agentsQuery.data?.total ?? 0;
  const loading = agentsQuery.isLoading;
  const refreshing = agentsQuery.isFetching;

  const frameworks = useMemo(() => {
    const set = new Set<string>();
    agents.forEach((a) => a.framework && set.add(a.framework));
    return Array.from(set).sort();
  }, [agents]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (frameworkFilter && a.framework !== frameworkFilter) return false;
      if (q) {
        const hay = `${a.name} ${a.agent_id} ${a.framework ?? ""} ${a.repo_url ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [agents, search, frameworkFilter]);

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Bot}
        feature="Agents"
        description="Agents you register via the SDK or CLI appear here. Once your org is set up you can upload code, run sims, and inspect test results for each one."
      />
    );
  }

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          title="Agents"
          subtitle={
            loading
              ? "Loading…"
              : `${total} registered · SDK first; link a repo only when you need GitHub listing.`
          }
          description="Agents appear after SDK/CLI registration. Linking a GitHub repo is optional."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild className="min-h-11">
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open docs quickstart"
                >
                  Docs quickstart
                </a>
              </Button>
              {canLinkRepo ? (
                <Button asChild variant="outline" className="min-h-11">
                  <Link href="/agents/connect" aria-label="Link a repository (optional)">
                    <Plus className="w-4 h-4" />
                    Link repo
                  </Link>
                </Button>
              ) : null}
              {tab === "agents" && (
                <Button
                  onClick={() => void agentsQuery.refetch()}
                  variant="ghost"
                  size="default"
                  disabled={refreshing}
                  loading={refreshing}
                  aria-label="Refresh agents"
                >
                  <RefreshCw className="h-4 w-4" /> Refresh
                </Button>
              )}
            </div>
          }
        />
      }
      toolbar={
        <div className="mb-4 space-y-3">
          <CrossLinkBar
            links={[
              { label: "Fleet", href: "/agents?tab=fleet" },
              { label: "Improve", href: "/improve" },
              { label: "Ledger", href: "/ledger" },
              { label: "Audit trail", href: "/audit-trail" },
            ]}
          />
          <div role="tablist" aria-label="Agents sections" className="flex gap-1 border-b border-[var(--border-default)]">
            {AGENT_TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px",
                  tab === t
                    ? "border-[var(--accent)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      }
      table={
        tab === "fleet" ? (
          <EmbeddedSurface>
            <FleetView />
          </EmbeddedSurface>
        ) : (
      <QueryState
        loading={loading && agents.length === 0}
        error={agentsQuery.error}
        data={agentsQuery.data}
        onRetry={() => void agentsQuery.refetch()}
        errorTitle="Could not load agents"
        isEmpty={(d) => (d?.agents.length ?? 0) === 0}
        loadingSlot={
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Panel key={i} tone="flat" padding="md" className="space-y-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </Panel>
            ))}
          </div>
        }
        emptySlot={
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description={
              canManageKeys
                ? "Register via the SDK or CLI after you create an API key. Linking a GitHub repo is optional and does not install the SDK."
                : "Register via the SDK or CLI after an admin shares an API key. Linking a GitHub repo is optional and requires an admin."
            }
            size="lg"
            action={
              <div className="flex flex-col items-center gap-3 text-sm">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button asChild className="min-h-11">
                    <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                      Docs quickstart
                    </a>
                  </Button>
                  {canManageKeys ? (
                    <Button asChild variant="outline" className="min-h-11">
                      <Link href="/settings?tab=api-keys">Create API key</Link>
                    </Button>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)] px-3 py-2">
                      Ask an admin for an API key
                    </span>
                  )}
                  {canLinkRepo ? (
                    <Button asChild variant="outline" className="min-h-11">
                      <Link href="/agents/connect">Link repo (optional)</Link>
                    </Button>
                  ) : null}
                </div>
                <code className="px-3 py-1.5 rounded bg-[var(--bg-tertiary)] font-mono text-xs text-[var(--text-secondary)]">
                  eden config discover-agents
                </code>
                <span className="text-xs text-[var(--text-muted)]">
                  or call <code className="font-mono">register_agent()</code> at agent startup.
                </span>
              </div>
            }
          />
        }
      >
        {() => (
          <>
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
              <div className="relative flex-1 min-w-0">
                <Search
                  aria-hidden="true"
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, framework, or repo…"
                  aria-label="Search agents by name, framework, or repo"
                  className="w-full pl-9 pr-9 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {frameworks.length > 1 && (
                <div className="relative">
                  <Filter
                    aria-hidden="true"
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none"
                  />
                  <select
                    value={frameworkFilter}
                    onChange={(e) => setFrameworkFilter(e.target.value)}
                    aria-label="Filter agents by framework"
                    className="pl-8 pr-8 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  >
                    <option value="">All frameworks</option>
                    {frameworks.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="mt-3">
                <EmptyState
                  icon={Search}
                  title="No matches"
                  description="No agents match the current filters."
                  size="sm"
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setFrameworkFilter("");
                      }}
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      Clear filters
                    </button>
                  }
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
                {filtered.map((a) => (
                  <AgentCard key={a.agent_id} agent={a} />
                ))}
              </div>
            )}

            {!search && !frameworkFilter && agents.length < total && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="default"
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                  loading={refreshing}
                  disabled={refreshing}
                >
                  Load more agents ({total - agents.length} remaining)
                </Button>
              </div>
            )}
          </>
        )}
      </QueryState>
        )
      }
    />
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  const repoHost = (() => {
    if (!agent.repo_url) return null;
    try {
      return new URL(agent.repo_url).hostname.replace(/^www\./, "");
    } catch {
      return agent.repo_url;
    }
  })();

  // 24h threshold computed once per render — sufficient for a card badge.
  // The badge will refresh on the next render after the page re-fetches.
  const isLive = agent.last_seen_at
    ? Date.now() - new Date(agent.last_seen_at).getTime() < 1000 * 60 * 60 * 24
    : false;

  return (
    <Link
      href={`/agents/${encodeURIComponent(agent.agent_id)}`}
      aria-label={`Open agent ${agent.name}`}
      className="group"
    >
      <Card className="p-5 h-full hover:border-[var(--accent)]/40 hover:bg-[var(--bg-secondary)]/40 transition-colors">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "p-2 rounded-lg flex-shrink-0",
              isLive
                ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
            )}
          >
            <Bot className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                {agent.name}
              </h3>
              {isLive && (
                <span
                  title="Active in the last 24h"
                  aria-label="Active in the last 24 hours"
                  className="w-1.5 h-1.5 rounded-full bg-[var(--terminal)] flex-shrink-0"
                />
              )}
            </div>
            <p className="text-[11px] font-mono text-[var(--text-muted)] truncate mt-0.5">
              {agent.agent_id}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {agent.framework && (
            <span
              className={cn(
                "text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded",
                FRAMEWORK_BADGE[agent.framework] ?? FRAMEWORK_BADGE.none,
              )}
            >
              {agent.framework}
            </span>
          )}
        </div>

        <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" aria-hidden="true" />
            {formatRelative(agent.last_seen_at)}
          </span>
          {repoHost && (
            <span className="flex items-center gap-1 truncate ml-2">
              <ExternalLink className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              <span className="truncate max-w-[140px]">{repoHost}</span>
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}
