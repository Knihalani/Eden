"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { GitBranch } from "lucide-react";
import {
  improvePlansApi,
  type ImprovementPlan,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  isImprovementAgentDisabled,
  IMPROVE_FEATURE_DISABLED_TITLE,
  IMPROVE_FEATURE_DISABLED_DESCRIPTION,
} from "@/lib/improve-feature";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatRelativeTime } from "@/lib/format";
import {
  EvidenceStrip,
  RcaPanel,
  RelatedStrip,
} from "@/components/improve";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";
import { CreatePlanDialog } from "./create-plan-dialog";

export type PlansTabProps = {
  canMutate: boolean;
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

export function PlansTab({ canMutate }: PlansTabProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { state, setState, clearSelection } = useImproveUrlState();
  const isXl = useIsXl();
  const [createOpen, setCreateOpen] = useState(false);

  const plansQuery = useOrgQuery(
    queryKeys.improve.plans(orgId, { agentId: state.agentId, q: state.q }),
    orgId,
    () => {
      const q = new URLSearchParams();
      if (state.agentId) q.set("agent_id", state.agentId);
      if (state.q) q.set("q", state.q);
      return improvePlansApi.listPlans(orgId!, q.toString());
    },
  );

  const featureDisabled = isImprovementAgentDisabled(plansQuery.error);

  const plans = useMemo(
    () => plansQuery.data?.data?.plans ?? [],
    [plansQuery.data],
  );

  const filtered = useMemo(() => {
    const q = (state.q ?? "").trim().toLowerCase();
    if (!q) return plans;
    return plans.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.agent_id ?? "").toLowerCase().includes(q),
    );
  }, [plans, state.q]);

  const selected =
    filtered.find((p) => p.id === state.planId) ??
    plans.find((p) => p.id === state.planId) ??
    null;

  const columns: DataTableColumn<ImprovementPlan>[] = [
    {
      key: "title",
      header: t("plans.col.title"),
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--text-primary)]">
            {row.title}
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)]">
            {row.id}
          </div>
        </div>
      ),
    },
    {
      key: "kind",
      header: t("plans.col.kind"),
      cell: (row) => row.plan_kind,
    },
    {
      key: "status",
      header: t("plans.col.status"),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "agent",
      header: t("plans.col.agent"),
      cell: (row) => row.agent_id ?? "—",
    },
    {
      key: "updated",
      header: t("plans.col.updated"),
      cell: (row) => formatRelativeTime(row.updated_at || row.created_at),
    },
  ];

  const detailOpen = Boolean(state.planId);
  const evidence = selected?.evidence ?? {};
  const issueId =
    typeof evidence.issue_id === "string"
      ? evidence.issue_id
      : typeof evidence.issueId === "string"
        ? evidence.issueId
        : state.issueId;

  const detailBody = selected ? (
    <div className="space-y-4 p-4" data-testid="plan-hub-detail">
      <EvidenceStrip
        links={[
          issueId
            ? {
                href: `/issues?issueId=${encodeURIComponent(issueId)}`,
                label: `Issue ${issueId}`,
              }
            : null,
          selected.agent_id
            ? {
                href: `/agents/${encodeURIComponent(selected.agent_id)}`,
                label: selected.agent_id,
              }
            : null,
        ].filter(Boolean) as Array<{ href: string; label: string }>}
      />
      <RcaPanel summary={selected.summary} />
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" className="min-h-11">
          <Link href={`/improve/plans/${encodeURIComponent(selected.id)}`}>
            {t("plans.openFull")}
          </Link>
        </Button>
      </div>
      <RelatedStrip
        links={[
          {
            href: `/improve/plans/${encodeURIComponent(selected.id)}?panel=artifacts`,
            label: t("related.artifacts"),
          },
          {
            href: `/improve?tab=ledger&agentId=${encodeURIComponent(selected.agent_id ?? "")}`,
            label: t("related.ledger"),
          },
          { href: "/cost?tab=advisor", label: t("related.cost") },
        ]}
      />
    </div>
  ) : null;

  return (
    <div data-testid="improve-plans-tab">
      {canMutate ? (
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            onClick={() => setCreateOpen(true)}
            data-testid="plans-new"
          >
            {t("plans.new")}
          </Button>
        </div>
      ) : null}

      <ResourcePageShell
        table={
          <QueryState
            loading={plansQuery.isLoading}
            error={featureDisabled ? null : plansQuery.error}
            data={featureDisabled ? [] : filtered}
            onRetry={() => void plansQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            filtersActive={Boolean(state.q || state.agentId)}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              featureDisabled ? (
                <EmptyState
                  icon={GitBranch}
                  title={IMPROVE_FEATURE_DISABLED_TITLE}
                  description={IMPROVE_FEATURE_DISABLED_DESCRIPTION}
                />
              ) : (
                <EmptyState
                  icon={GitBranch}
                  title={t("plans.empty.title")}
                  description={t("plans.empty.body")}
                  action={
                    canMutate ? (
                      <Button
                        type="button"
                        size="sm"
                        className="min-h-11"
                        onClick={() => setCreateOpen(true)}
                      >
                        {t("plans.new")}
                      </Button>
                    ) : (
                      <Button asChild size="sm" className="min-h-11">
                        <Link href="/issues">{t("queue.empty.cta")}</Link>
                      </Button>
                    )
                  }
                />
              )
            }
            filterEmptySlot={
              <EmptyState
                title={t("plans.filterEmpty.title")}
                description={t("plans.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => setState({ q: undefined, agentId: undefined })}
                  >
                    {t("plans.filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(rows) => (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                highlightRowId={state.planId}
                onRowClick={(row) => setState({ planId: row.id })}
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
              headerActions={<StatusBadge status={selected.status} />}
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
          headerActions={<StatusBadge status={selected.status} />}
        >
          {detailBody}
        </DetailPanelShell>
      ) : null}

      <CreatePlanDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
