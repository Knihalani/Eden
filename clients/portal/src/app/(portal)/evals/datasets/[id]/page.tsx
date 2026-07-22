"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { datasetsApi, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";
import { DatasetDetailBody } from "../../_components/dataset-detail-panel";

function DatasetDetailPageInner() {
  const t = useTranslations("evals");
  const params = useParams<{ id: string }>();
  const datasetId = decodeURIComponent(params.id ?? "");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");

  const detailQuery = useOrgQuery(
    queryKeys.datasets.detail(orgId, datasetId),
    orgId,
    () => datasetsApi.get(orgId!, datasetId),
    { enabled: Boolean(datasetId) },
  );

  const name = detailQuery.data?.name;
  const is404 =
    detailQuery.error instanceof ApiError && detailQuery.error.status === 404;

  return (
    <div
      className="mx-auto max-w-4xl space-y-4"
      data-testid="evals-dataset-detail-page"
    >
      <nav
        className="text-sm text-[var(--text-muted)]"
        aria-label={t("datasets.detail.breadcrumbAria")}
      >
        <span>{t("breadcrumb.evaluate")}</span>
        <span className="mx-1.5" aria-hidden>
          /
        </span>
        <Link
          href="/evals"
          className="hover:text-[var(--text-primary)] hover:underline"
        >
          {t("breadcrumb.evals")}
        </Link>
        <span className="mx-1.5" aria-hidden>
          /
        </span>
        <Link
          href="/evals?tab=datasets"
          className="hover:text-[var(--text-primary)] hover:underline"
        >
          {t("breadcrumb.datasets")}
        </Link>
        <span className="mx-1.5" aria-hidden>
          /
        </span>
        <span className="text-[var(--text-secondary)]">
          {name ?? datasetId}
        </span>
      </nav>

      <PageHeader
        title={name ?? t("datasets.detail.panelTitle")}
        subtitle={t("datasets.detail.fullSubtitle")}
        actions={
          <Button asChild size="sm" variant="secondary" className="min-h-11">
            <Link href="/evals?tab=datasets">
              {t("datasets.detail.backToList")}
            </Link>
          </Button>
        }
      />

      {is404 ? (
        <Panel tone="flat" padding="md" role="alert" data-testid="dataset-not-found">
          <p className="m-0 text-sm text-[var(--text-secondary)]">
            {t("datasets.detail.notFound")}
          </p>
          <Button asChild size="sm" className="mt-3 min-h-11">
            <Link href="/evals?tab=datasets">
              {t("datasets.detail.backToList")}
            </Link>
          </Button>
        </Panel>
      ) : (
        <DatasetDetailBody
          datasetId={datasetId}
          listRow={detailQuery.data ?? null}
          canMutate={canMutate}
          fullPage
        />
      )}
    </div>
  );
}

export default function EvalsDatasetDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-4xl space-y-4 p-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <DatasetDetailPageInner />
    </Suspense>
  );
}
