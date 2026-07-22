"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowUpRight } from "lucide-react";
import { learnApi } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatRelativeTime } from "@/lib/format";
import { RelatedStrip } from "@/components/improve";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";

export type PromotionsTabProps = {
  canMutate: boolean;
};

type PromoRow = {
  id: string;
  title: string;
  status: string;
  artifactId?: string;
  agentId?: string;
  createdAt?: string;
  raw: Record<string, unknown>;
};

function useIsXl() {
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setIsXl(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isXl;
}

function toRow(raw: Record<string, unknown>): PromoRow {
  const id = String(raw.id ?? raw.candidate_id ?? raw.promotion_id ?? "");
  return {
    id,
    title: String(raw.title ?? raw.summary ?? raw.name ?? id),
    status: String(raw.status ?? "pending"),
    artifactId:
      (typeof raw.artifact_id === "string" && raw.artifact_id) ||
      (typeof raw.artifactId === "string" && raw.artifactId) ||
      undefined,
    agentId:
      (typeof raw.agent_id === "string" && raw.agent_id) ||
      (typeof raw.agentId === "string" && raw.agentId) ||
      undefined,
    createdAt:
      (typeof raw.created_at === "string" && raw.created_at) ||
      (typeof raw.createdAt === "string" && raw.createdAt) ||
      undefined,
    raw,
  };
}

export function PromotionsTab({ canMutate }: PromotionsTabProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState, clearSelection } = useImproveUrlState();
  const isXl = useIsXl();

  const listQuery = useOrgQuery(
    ["improve", "promotions", orgId] as const,
    orgId,
    () => learnApi.listPromotions(orgId!),
  );

  const rows = useMemo(() => {
    const promotions = listQuery.data?.data?.promotions ?? [];
    return promotions.map((p) => toRow(p as Record<string, unknown>)).filter((r) => r.id);
  }, [listQuery.data]);

  const filtered = useMemo(() => {
    const q = (state.q ?? "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.artifactId ?? "").toLowerCase().includes(q),
    );
  }, [rows, state.q]);

  const selected =
    filtered.find((r) => r.id === state.promotionId) ??
    rows.find((r) => r.id === state.promotionId) ??
    null;

  const approveMutation = useOrgMutation(
    (id: string) => learnApi.approvePromotion(orgId!, id),
    {
      onSuccess: () => {
        void listQuery.refetch();
        setState({ tab: "ledger" });
      },
      onError: (err) => toast.error(err.message || t("promotions.approveFailed")),
    },
  );

  const rejectMutation = useOrgMutation(
    (vars: { id: string; reason?: string }) =>
      learnApi.rejectPromotion(orgId!, vars.id, vars.reason),
    {
      onSuccess: () => void listQuery.refetch(),
      onError: (err) => toast.error(err.message || t("promotions.rejectFailed")),
    },
  );

  const columns: DataTableColumn<PromoRow>[] = [
    {
      key: "title",
      header: t("promotions.col.title"),
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.title}</div>
          <div className="font-mono text-xs text-[var(--text-muted)]">
            {row.id}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: t("promotions.col.status"),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "artifact",
      header: t("promotions.col.artifact"),
      cell: (row) => row.artifactId ?? "—",
    },
    {
      key: "age",
      header: t("promotions.col.age"),
      cell: (row) =>
        row.createdAt ? formatRelativeTime(row.createdAt) : "—",
    },
  ];

  const detailOpen = Boolean(state.promotionId);

  const detailBody = selected ? (
    <div className="space-y-4 p-4" data-testid="promotion-detail">
      <StatusBadge status={selected.status} />
      <pre className="max-h-48 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2 font-mono text-xs">
        {JSON.stringify(selected.raw, null, 2)}
      </pre>
      {canMutate && selected.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            loading={approveMutation.isPending}
            onClick={() => void approveMutation.mutateAsync(selected.id)}
          >
            {t("promotions.approve")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-11"
            loading={rejectMutation.isPending}
            onClick={() =>
              void rejectMutation.mutateAsync({ id: selected.id })
            }
          >
            {t("promotions.reject")}
          </Button>
        </div>
      ) : null}
      <RelatedStrip
        links={[
          selected.artifactId
            ? {
                href: `/improve?tab=artifacts&artifactId=${encodeURIComponent(selected.artifactId)}`,
                label: t("related.artifacts"),
              }
            : null,
          { href: "/improve?tab=ledger", label: t("related.ledger") },
        ].filter(Boolean) as Array<{ href: string; label: string }>}
      />
    </div>
  ) : null;

  return (
    <div data-testid="improve-promotions-tab">
      <ResourcePageShell
        table={
          <QueryState
            loading={listQuery.isLoading}
            error={listQuery.error}
            data={filtered}
            onRetry={() => void listQuery.refetch()}
            isEmpty={(r) => r.length === 0}
            filtersActive={Boolean(state.q)}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={ArrowUpRight}
                title={t("promotions.empty.title")}
                description={t("promotions.empty.body")}
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/improve?tab=artifacts">
                      {t("promotions.empty.cta")}
                    </Link>
                  </Button>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                title={t("promotions.filterEmpty.title")}
                description={t("promotions.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => setState({ q: undefined })}
                  >
                    {t("promotions.filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(data) => (
              <DataTable
                columns={columns}
                rows={data}
                rowKey={(r) => r.id}
                highlightRowId={state.promotionId}
                onRowClick={(row) => setState({ promotionId: row.id })}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl && selected ? (
            <DetailPanelShell
              open
              onClose={clearSelection}
              title={selected.title}
              mobileDrawer={false}
            >
              {detailBody}
            </DetailPanelShell>
          ) : undefined
        }
      />

      {detailOpen && !isXl && selected ? (
        <DetailPanelShell
          open
          onClose={clearSelection}
          title={selected.title}
          mobileDrawer
        >
          {detailBody}
        </DetailPanelShell>
      ) : null}
    </div>
  );
}
