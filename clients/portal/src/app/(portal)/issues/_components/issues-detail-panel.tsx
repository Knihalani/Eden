"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { AgentIssue } from "@/lib/api";
import { agentIssuesApi } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Loader2 } from "lucide-react";
import {
  artifactHref,
  experimentHref,
  improveHref,
  issueFullHref,
  preserveFromSearchParams,
} from "@/lib/portal-cross-links";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { DetailPanelShell } from "@/components/portal-os";
import { IssueSeverityBadge, StatusBadge } from "./issue-badges";
import { IssueStumblesList } from "./issue-stumbles-list";

export function IssuesDetailPanel({
  issueId,
  selectedIssue,
  loading,
  notFound,
  error,
  onClose,
  onPrev,
  onNext,
  onRetry,
  onPrimaryAction,
  primaryBusy,
}: {
  issueId: string;
  selectedIssue: AgentIssue | null;
  loading: boolean;
  notFound: boolean;
  error: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onRetry: () => void;
  onPrimaryAction: () => void;
  primaryBusy: boolean;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const searchParams = useSearchParams();
  const preserve = useMemo(() => preserveFromSearchParams(searchParams), [searchParams]);

  const fingerprint = selectedIssue?.fingerprint;
  const stumblesQuery = useOrgQuery(
    queryKeys.issues.stumbles(orgId, { fingerprint, limit: 5 }),
    orgId,
    () =>
      agentIssuesApi
        .stumbles(orgId!, { fingerprint: fingerprint!, limit: 5 })
        .then((res) => res.data?.stumbles ?? []),
    { enabled: Boolean(orgId) && Boolean(fingerprint) },
  );
  const stumbles = stumblesQuery.data ?? [];
  const stumblesError = stumblesQuery.error?.message ?? null;

  return (
    <DetailPanelShell
      open
      onClose={onClose}
      title={selectedIssue?.title ?? "Issue"}
      onPrev={onPrev}
      onNext={onNext}
      headerActions={
        <div className="flex flex-wrap items-center gap-space-2">
          {selectedIssue ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-11" aria-label="Related surfaces">
                  Go to
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel>Go to</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href={improveHref(selectedIssue.id)} data-testid="issue-improve-link">
                    Improve plan
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={experimentHref(undefined, selectedIssue.id)}>Run experiment</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={artifactHref()}>Create artifact</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={issueFullHref(selectedIssue.id)}>Export fixture</Link>
                </DropdownMenuItem>
                {selectedIssue.experiment_id ? (
                  <DropdownMenuItem asChild>
                    <Link href={experimentHref(selectedIssue.experiment_id)}>
                      Linked experiment
                    </Link>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button variant="outline" size="sm" asChild className="min-h-11">
            <Link href={issueFullHref(issueId)}>Open full page</Link>
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center p-8 text-sm text-[var(--text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : notFound || (!selectedIssue && !error) ? (
        <p className="p-4 text-sm text-[var(--text-muted)]">Issue not found.</p>
      ) : error ? (
        <ErrorState
          title="Could not load issue"
          message={error}
          size="sm"
          className="m-4"
          action={
            <Button variant="outline" size="sm" className="min-h-11" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : selectedIssue ? (
        <div className="flex h-full flex-col" data-testid="issues-detail-slim">
          <div className="space-y-space-4 p-space-4 text-sm">
            <div className="flex flex-wrap gap-space-2">
              <IssueSeverityBadge severity={selectedIssue.severity} />
              <StatusBadge status={selectedIssue.status} />
            </div>
            <section aria-label="Evidence" data-testid="issues-detail-evidence">
              <h3 className="mb-space-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Evidence
              </h3>
              <p className="text-[var(--text-secondary)]">
                {typeof selectedIssue.triage_result?.summary === "string"
                  ? selectedIssue.triage_result.summary
                  : typeof selectedIssue.triage_result?.root_cause === "string"
                    ? selectedIssue.triage_result.root_cause
                    : `${selectedIssue.kind} · ${selectedIssue.status}`}
              </p>
              <dl className="mt-space-3 grid gap-space-2 text-xs">
                <div className="flex justify-between gap-space-4">
                  <dt className="text-[var(--text-muted)]">Stumbles</dt>
                  <dd>{selectedIssue.stumble_count}</dd>
                </div>
                <div className="flex justify-between gap-space-4">
                  <dt className="text-[var(--text-muted)]">Users</dt>
                  <dd>{selectedIssue.user_count}</dd>
                </div>
                {selectedIssue.agent_id ? (
                  <div className="flex justify-between gap-space-4">
                    <dt className="text-[var(--text-muted)]">Agent</dt>
                    <dd className="truncate font-mono">{selectedIssue.agent_id}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="mt-space-3">
                <IssueStumblesList
                  stumbles={stumbles}
                  error={stumblesError}
                  onRetry={() => void stumblesQuery.refetch()}
                  preserve={preserve}
                  compact
                  maxRows={5}
                  loading={stumblesQuery.isLoading && Boolean(fingerprint)}
                />
              </div>
            </section>
            <div
              className="flex flex-wrap gap-space-2 border-t border-[var(--border-subtle)] pt-space-3"
              data-testid="issues-detail-one-action"
            >
              <Button size="sm" variant="default" asChild>
                <Link href={improveHref(selectedIssue.id)} data-testid="issue-improve-link">
                  Open Improve
                </Link>
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link href={issueFullHref(selectedIssue.id)}>Full page</Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={primaryBusy}
                onClick={onPrimaryAction}
              >
                Re-triage
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-[var(--text-muted)]">Issue not found.</p>
      )}
    </DetailPanelShell>
  );
}
