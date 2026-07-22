"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { agentIssuesApi, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useObserveUrlState } from "@/app/(portal)/_hooks/use-observe-url-state";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";
import { IssueDetailBody } from "../_components/issue-detail-panel";
import {
  mapIssue,
  mapStumbleToFinding,
  type FindingRow,
  type IssueRow,
} from "../_components/issue-map";

function IssueDetailPageInner() {
  const t = useTranslations("issues");
  const params = useParams<{ id: string }>();
  const issueId = decodeURIComponent(params.id ?? "");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");
  const { searchParams } = useObserveUrlState();

  const detailQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId),
    { enabled: Boolean(issueId) },
  );

  const issue: IssueRow | null = detailQuery.data?.data?.issue
    ? mapIssue(detailQuery.data.data.issue)
    : null;

  const fingerprint = issue?.fingerprint;

  const stumblesQuery = useOrgQuery(
    queryKeys.issues.stumbles(orgId, { fingerprint }),
    orgId,
    () =>
      agentIssuesApi.stumbles(orgId!, {
        fingerprint: fingerprint!,
        limit: 50,
      }),
    { enabled: Boolean(fingerprint) },
  );

  const findings: FindingRow[] = useMemo(
    () => (stumblesQuery.data?.data?.stumbles ?? []).map(mapStumbleToFinding),
    [stumblesQuery.data],
  );

  const resolveMutation = useOrgMutation(
    () => agentIssuesApi.resolve(orgId!, issueId, { status: "resolved" }),
    {
      invalidateKeys: [
        queryKeys.issues.list(orgId, { limit: 100 }),
        queryKeys.issues.detail(orgId, issueId),
      ],
    },
  );

  const triageMutation = useOrgMutation(
    () => agentIssuesApi.triage(orgId!, issueId, { force: false }),
    {
      invalidateKeys: [
        queryKeys.issues.list(orgId, { limit: 100 }),
        queryKeys.issues.detail(orgId, issueId),
      ],
    },
  );

  const is404 =
    detailQuery.error instanceof ApiError && detailQuery.error.status === 404;

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="issue-detail-page">
      <nav
        className="text-sm text-[var(--text-muted)]"
        aria-label={t("detail.breadcrumbAria")}
      >
        <Link href="/issues" className="hover:text-[var(--text-primary)] hover:underline">
          {t("title")}
        </Link>
        <span className="mx-1.5" aria-hidden>
          /
        </span>
        <span className="text-[var(--text-secondary)]">
          {issue?.title ?? issueId}
        </span>
      </nav>

      <PageHeader
        title={issue?.title ?? t("detail.panelTitle")}
        subtitle={t("detail.fullSubtitle")}
        actions={
          <Button asChild size="sm" variant="secondary" className="min-h-11">
            <Link href="/issues">{t("detail.backToList")}</Link>
          </Button>
        }
      />

      {is404 ? (
        <Panel tone="flat" padding="md" role="alert" data-testid="issue-not-found">
          <p className="m-0 text-sm text-[var(--text-secondary)]">
            {t("detail.notFound")}
          </p>
          <Button asChild size="sm" className="mt-3 min-h-11">
            <Link href="/issues">{t("detail.backToList")}</Link>
          </Button>
        </Panel>
      ) : (
        <IssueDetailBody
          issue={issue}
          findings={findings}
          loading={detailQuery.isLoading}
          error={detailQuery.error}
          onRetry={() => {
            void detailQuery.refetch();
            void stumblesQuery.refetch();
          }}
          searchParams={searchParams}
          canMutate={canMutate}
          onResolve={
            canMutate
              ? () => {
                  void resolveMutation.mutateAsync();
                }
              : undefined
          }
          onTriage={
            canMutate
              ? () => {
                  void triageMutation.mutateAsync();
                }
              : undefined
          }
          mutating={resolveMutation.isPending || triageMutation.isPending}
          fullPage
        />
      )}
    </div>
  );
}

export default function IssueDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl space-y-4 p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      <IssueDetailPageInner />
    </Suspense>
  );
}
