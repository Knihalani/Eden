/** Phase 3 — Agents list page (client-rendered for live filtering & refresh). */

"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { agentsApi, type AgentSummary } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import {
  Bot,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  Filter,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("");

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await agentsApi.list(currentOrg.id, { limit: 200 });
      setAgents(data.agents);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load agents";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, toast]);

  useEffect(() => {
     
    if (currentOrg) load();
  }, [currentOrg, load]);

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
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Fleet"
        title="Agents"
        subtitle={
          loading
            ? "Loading…"
            : `${agents.length} registered · click an agent to upload code, run sims, and inspect results.`
        }
        icon={Bot}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/agents/connect"
              aria-label="Connect a new agent"
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--accent)] text-[var(--bg-primary)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              Connect new agent
            </Link>
            <Button
              onClick={load}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
              aria-label="Refresh agents"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        }
      />

      {error && !loading && (
        <ErrorState
          title="Could not load agents"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading} loading={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      )}

      {/* Filters */}
      {agents.length > 0 && !error && (
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
              className="w-full pl-9 pr-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
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
      )}

      {/* Loading skeletons */}
      {loading && agents.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="p-5 space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && agents.length === 0 && (
        <Card className="p-8">
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Register your first agent via the SDK or CLI."
            size="lg"
            action={
              <div className="flex flex-col items-center gap-2 text-sm">
                <code className="px-3 py-1.5 rounded bg-[var(--bg-tertiary)] font-mono text-xs text-[var(--text-secondary)]">
                  eden config discover-agents
                </code>
                <span className="text-xs text-[var(--text-muted)]">
                  or call <code className="font-mono">register_agent()</code> at agent startup.
                </span>
              </div>
            }
          />
        </Card>
      )}

      {/* Filtered-out empty state */}
      {!loading && !error && agents.length > 0 && filtered.length === 0 && (
        <Card className="p-8">
          <EmptyState
            icon={Search}
            title="No matches"
            description="No agents match the current filters."
            size="sm"
            action={
              <button
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
        </Card>
      )}

      {/* Agent grid */}
      {!error && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((a) => (
            <AgentCard key={a.agent_id} agent={a} />
          ))}
        </div>
      )}
    </div>
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