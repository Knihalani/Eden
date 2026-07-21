/** Phase 3 — Agents list page (client-rendered for live filtering & refresh). */

"use client";

import { PageHeader } from "@/components/layout/page-header";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import {
  CoreResourcePage,
  useResourceUrlState,
} from "@/components/portal-os";
import {
  Bot,
  ChevronDown,
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
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentsApi, ApiError, type AgentSummary } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useState, useMemo, Suspense } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { AgentsDetailPanel } from "./_components/agents-detail-panel";

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
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const agentId = urlState.agentId;

  const agentsQuery = useOrgQuery(
    queryKeys.agents.list(orgId, { limit }),
    orgId,
    () => agentsApi.list(orgId!, { limit }),
  );

  const agents = agentsQuery.data?.agents ?? [];
  const total = agentsQuery.data?.total ?? 0;
  const loading = agentsQuery.isLoading;
  const refreshing = agentsQuery.isFetching;

  const agentDetailQuery = useOrgQuery(
    queryKeys.agents.detail(orgId, agentId ?? ""),
    orgId,
    () => agentsApi.get(orgId!, agentId!),
    { enabled: Boolean(orgId) && Boolean(agentId) && tab === "agents" },
  );
  const selectedAgent = agentDetailQuery.data ?? null;
  const agentDetailNotFound =
    agentDetailQuery.error instanceof ApiError && agentDetailQuery.error.status === 404;
  const agentDetailError = agentDetailQuery.error?.message ?? null;

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

  const agentIndex = agentId
    ? filtered.findIndex((a) => a.agent_id === agentId)
    : -1;

  useListKeyboardNav(
    filtered.length,
    agentIndex >= 0 ? agentIndex : 0,
    (idx) => {
      const row = filtered[idx];
      if (row) setUrlState({ agentId: row.agent_id });
    },
    tab === "agents" && filtered.length > 0,
  );

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Bot}
        feature="Agents"
        description="Registered agents appear here after the SDK or CLI reports them. Select or create an organization."
      />
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        const next = v as (typeof AGENT_TABS)[number];
        if (next === "fleet") setUrlState({ agentId: undefined });
        setTab(next);
      }}
    >
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="default"
                    className="min-h-11"
                    aria-label="Related surfaces"
                  >
                    More
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  <DropdownMenuLabel>Related</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href="/improve">Improve</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/ledger">Ledger</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/audit-trail">Audit trail</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />
      }
      toolbar={
        <div
          className="flex flex-wrap items-center gap-space-2"
          data-testid="agents-toolbar"
          data-wave7-agents="toolbar-one-band"
        >
          <TabsList
            variant="underline"
            aria-label="Agents sections"
            className="h-auto justify-start gap-1 bg-transparent"
          >
            <TabsTrigger variant="underline" value="agents" title="Agents" className="min-h-11 capitalize">
              Agents
            </TabsTrigger>
            <TabsTrigger variant="underline" value="fleet" title="Fleet" className="min-h-11 capitalize">
              Fleet
            </TabsTrigger>
          </TabsList>
          {tab === "agents" ? (
            <>
              <div className="relative min-w-[12rem] flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents…"
                  aria-label="Search agents by name, framework, or repo"
                  data-filter-search
                  className="min-h-11 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] py-2 pl-9 pr-9 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                />
                {search ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-[var(--text-muted)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
              {frameworks.length > 1 ? (
                <div className="relative">
                  <Filter
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
                  />
                  <select
                    value={frameworkFilter}
                    onChange={(e) => setFrameworkFilter(e.target.value)}
                    aria-label="Filter agents by framework"
                    className="min-h-11 cursor-pointer appearance-none rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] py-2 pl-8 pr-8 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  >
                    <option value="">All frameworks</option>
                    {frameworks.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <Button
                onClick={() => void agentsQuery.refetch()}
                variant="ghost"
                size="default"
                disabled={refreshing}
                loading={refreshing}
                aria-label="Refresh agents"
                className="min-h-11"
              >
                <RefreshCw className="h-4 w-4" /> Refresh
              </Button>
            </>
          ) : null}
        </div>
      }
      detail={
        tab === "agents" && agentId ? (
          <AgentsDetailPanel
            agentId={agentId}
            agent={selectedAgent}
            loading={agentDetailQuery.isLoading || agentDetailQuery.isPending}
            notFound={agentDetailNotFound}
            error={agentDetailError}
            onClose={() => setUrlState({ agentId: undefined })}
            onPrev={
              agentIndex > 0
                ? () => setUrlState({ agentId: filtered[agentIndex - 1]!.agent_id })
                : undefined
            }
            onNext={
              agentIndex >= 0 && agentIndex < filtered.length - 1
                ? () => setUrlState({ agentId: filtered[agentIndex + 1]!.agent_id })
                : undefined
            }
            onRetry={() => void agentDetailQuery.refetch()}
          />
        ) : undefined
      }
      table={
        <>
        <TabsContent value="fleet" className="mt-0">
          <EmbeddedSurface>
            <FleetView />
          </EmbeddedSurface>
        </TabsContent>
        <TabsContent value="agents" className="mt-0 space-y-space-4">
      <QueryState
        loading={loading && agents.length === 0}
        error={agentsQuery.error}
        data={agentsQuery.data}
        onRetry={() => void agentsQuery.refetch()}
        errorTitle="Could not load agents"
        isEmpty={(d) => (d?.agents.length ?? 0) === 0}
        loadingSlot={
          <div className="space-y-2" data-testid="agents-list-loading">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2.5"
              >
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24 ml-auto" />
              </div>
            ))}
          </div>
        }
        emptySlot={
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description={U20_EMPTY_COPY.agents}
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
            {filtered.length === 0 ? (
              <div className="mt-space-3">
                <EmptyState
                  icon={Search}
                  title="No matches"
                  description={U20_FILTER_EMPTY_COPY.agents}
                  size="sm"
                  action={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSearch("");
                        setFrameworkFilter("");
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              </div>
            ) : (
              <div
                className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
                data-testid="agents-table" data-wave10-agents="table" data-wave11-mobile="cards"
                role="table"
                aria-label="Agents"
              >
                <div
                  className="hidden sm:grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem_8rem] gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]"
                  role="row"
                >
                  <span role="columnheader">Name</span>
                  <span role="columnheader">Framework / repo</span>
                  <span role="columnheader">Last seen</span>
                  <span role="columnheader" className="text-right">
                    Status
                  </span>
                </div>
                <ul className="divide-y divide-[var(--border-subtle)]" role="rowgroup">
                  {filtered.map((a) => (
                    <AgentRow
                      key={a.agent_id}
                      agent={a}
                      selected={a.agent_id === agentId}
                      onSelect={() => setUrlState({ agentId: a.agent_id })}
                    />
                  ))}
                </ul>
              </div>
            )}

            {!search && !frameworkFilter && agents.length < total && (
              <div className="flex justify-center pt-space-2">
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
        </TabsContent>
        </>
      }
    />
    </Tabs>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const repoHost = (() => {
    if (!agent.repo_url) return null;
    try {
      return new URL(agent.repo_url).hostname.replace(/^www\./, "");
    } catch {
      return agent.repo_url;
    }
  })();

  const isLive = agent.last_seen_at
    ? Date.now() - new Date(agent.last_seen_at).getTime() < 1000 * 60 * 60 * 24
    : false;

  return (
    <li role="row">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open agent ${agent.name}`}
        aria-pressed={selected}
        className={cn(
          "grid w-full grid-cols-1 items-center gap-1 px-3 py-2.5 text-left transition-colors min-h-11 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem_8rem] sm:gap-3",
          selected
            ? "bg-[var(--accent-faint)]"
            : "hover:bg-[var(--bg-tertiary)]/50",
        )}
      >
        <div className="min-w-0" role="cell">
          <div className="flex min-w-0 items-center gap-2">
            <Bot
              className={cn(
                "h-4 w-4 shrink-0",
                isLive ? "text-[var(--terminal)]" : "text-[var(--text-muted)]",
              )}
              aria-hidden
            />
            <span className="truncate text-sm font-medium text-[var(--text-primary)]">
              {agent.name}
            </span>
          </div>
          <p className="truncate pl-6 font-mono text-xs text-[var(--text-muted)]">
            {agent.agent_id}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-6 sm:pl-0" role="cell">
          {agent.framework ? (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide",
                FRAMEWORK_BADGE[agent.framework] ?? FRAMEWORK_BADGE.none,
              )}
            >
              {agent.framework}
            </span>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">—</span>
          )}
          {repoHost ? (
            <span className="inline-flex max-w-[160px] items-center gap-1 truncate text-xs text-[var(--text-muted)]">
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{repoHost}</span>
            </span>
          ) : null}
        </div>
        <div
          className="flex items-center gap-1 pl-6 text-xs text-[var(--text-muted)] sm:pl-0"
          role="cell"
        >
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          {formatRelative(agent.last_seen_at)}
        </div>
        <div className="pl-6 text-xs sm:pl-0 sm:text-right" role="cell">
          {isLive ? (
            <span className="inline-flex items-center gap-1.5 text-[var(--terminal)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" aria-hidden />
              Live
            </span>
          ) : (
            <span className="text-[var(--text-muted)]">Idle</span>
          )}
        </div>
      </button>
    </li>
  );
}

