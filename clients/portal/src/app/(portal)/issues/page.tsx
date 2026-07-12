"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, type AgentIssue } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { RepeatBadge, SeverityBadge, StatusBadge } from "./_components/issue-badges";

const STATUS_FILTERS = [
  "all",
  "open",
  "triaged",
  "fix_pending",
  "verifying",
  "resolved",
  "regressed",
] as const;

export default function IssuesPage() {
  const { currentOrg } = useOrg();
  const [issues, setIssues] = useState<AgentIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await agentIssuesApi.list(currentOrg.id, {
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: 100,
      });
      setIssues(res.data?.issues ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load issues");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Agent Issues"
        icon={ShieldAlert}
        description="Select an organization to review grouped agent failures"
      />
    );
  }

  return (
    <PageContent size="default">
      <PageHeader
        title="Agent Issues"
        subtitle="Grouped agent failures (stumbles) with auto-triage, self-heal, and verify lifecycle."
        icon={ShieldAlert}
      />

      <div role="tablist" aria-label="Issue status filter" className="flex items-center gap-1 mb-4 border-b border-[var(--border-default)] overflow-x-auto">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap capitalize",
              statusFilter === s
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-2 rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-3 text-sm text-[var(--error)]">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Failed to load issues</p>
              <p className="text-xs mt-1 opacity-80">{error}</p>
            </div>
          </div>
          <button onClick={load} disabled={loading} className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50 shrink-0">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div role="status" aria-busy="true" className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
        </div>
      ) : issues.length === 0 ? (
        <Card padding="lg">
          <EmptyState
            icon={ShieldAlert}
            title="No issues in this view"
            description="Issues appear automatically as Eden detects agent failures in finalized traces."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {issues.map((i) => (
            <Link
              key={i.id}
              href={`/issues/${i.id}`}
              className="block rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 hover:border-[var(--accent)] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SeverityBadge severity={i.severity} />
                    <StatusBadge status={i.status} />
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                      {i.kind}
                    </span>
                    {i.repetition_count > 1 && <RepeatBadge count={i.repetition_count} />}
                  </div>
                  <p className="mt-2 text-sm font-medium text-[var(--text-primary)] truncate">{i.title}</p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {i.stumble_count} stumble{i.stumble_count === 1 ? "" : "s"} · {i.user_count} user{i.user_count === 1 ? "" : "s"}
                    {i.agent_id ? ` · ${i.agent_id}` : ""}
                    {i.last_seen ? ` · last seen ${new Date(i.last_seen).toLocaleString()}` : ""}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageContent>
  );
}
