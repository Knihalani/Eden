"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Bot, ExternalLink, Loader2, ChevronDown } from "lucide-react";
import type { AgentSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { DetailPanelShell } from "@/components/portal-os";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
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

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-space-4">
      <span className="shrink-0 text-xs uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-xs text-[var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

export function AgentsDetailPanel({
  agentId,
  agent,
  loading,
  notFound,
  error,
  onClose,
  onPrev,
  onNext,
  onRetry,
}: {
  agentId: string;
  agent: AgentSummary | null;
  loading: boolean;
  notFound: boolean;
  error: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onRetry: () => void;
}) {
  const encodedId = encodeURIComponent(agentId);
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

  return (
    <DetailPanelShell
      open
      onClose={onClose}
      title={agent?.name ?? agentId}
      onPrev={onPrev}
      onNext={onNext}
      headerActions={
        <div className="flex flex-wrap items-center gap-space-2">
          <Button asChild size="sm" className="min-h-11">
            <Link href={`/agents/${encodedId}`}>Open full</Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                aria-label="Related agent surfaces"
              >
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
                <Link href={tracesFilteredHref({ agent_id: agentId })}>
                  Traces
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <div
        className="flex flex-col gap-space-3 p-space-4"
        data-testid="agents-detail-panel"
        data-wave7-agents="master-detail"
      >
        {loading && !agent ? (
          <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading agent…
          </div>
        ) : notFound ? (
          <EmptyState
            icon={Bot}
            title="Agent not found"
            description={`No agent with id ${agentId} in this organisation.`}
            size="sm"
            variant="plain"
          />
        ) : error ? (
          <ErrorState
            title="Could not load agent"
            message={error}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        ) : agent ? (
          <>
            <p className="font-mono text-xs text-[var(--text-muted)]">{agent.agent_id}</p>
            <DetailRow
              label="Status"
              value={
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    isLive ? "text-[var(--terminal)]" : "text-[var(--text-muted)]",
                  )}
                >
                  {isLive ? (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-[var(--terminal)]"
                      aria-hidden
                    />
                  ) : null}
                  {isLive ? "Live" : "Idle"}
                </span>
              }
            />
            <DetailRow label="Last seen" value={formatRelative(agent.last_seen_at)} />
            <DetailRow label="Framework" value={agent.framework ?? "—"} />
            <DetailRow
              label="Repo"
              value={
                agent.repo_url && repoHost ? (
                  <a
                    href={agent.repo_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                  >
                    {repoHost}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : (
                  "Not linked"
                )
              }
            />
          </>
        ) : null}
      </div>
    </DetailPanelShell>
  );
}
