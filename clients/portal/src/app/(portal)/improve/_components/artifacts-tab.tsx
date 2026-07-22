"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Package } from "lucide-react";
import { learnApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import {
  isRepoNotConnected,
  REPO_NOT_CONNECTED_MESSAGE,
} from "@/lib/improve-feature";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";
import {
  ArtifactVersionTable,
  type ArtifactVersionRow,
  EvidenceGateBanner,
  evaluateEvidenceGate,
  OutcomeTriad,
  RelatedStrip,
  ShowCodePanel,
} from "@/components/improve";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";

export type ArtifactsTabProps = {
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

function toRow(raw: Record<string, unknown>): ArtifactVersionRow {
  return {
    id: String(raw.id ?? raw.artifact_id ?? ""),
    title: String(raw.title ?? raw.name ?? raw.id ?? "Artifact"),
    kind: raw.kind != null ? String(raw.kind) : undefined,
    version: (raw.version as string | number | undefined) ?? undefined,
    agentId:
      (typeof raw.agent_id === "string" && raw.agent_id) ||
      (typeof raw.agentId === "string" && raw.agentId) ||
      null,
    planId:
      (typeof raw.plan_id === "string" && raw.plan_id) ||
      (typeof raw.planId === "string" && raw.planId) ||
      null,
    status: raw.status != null ? String(raw.status) : undefined,
    gate: raw.gate != null ? String(raw.gate) : undefined,
    createdAt:
      (typeof raw.created_at === "string" && raw.created_at) ||
      (typeof raw.createdAt === "string" && raw.createdAt) ||
      null,
  };
}

export function ArtifactsTab({ canMutate }: ArtifactsTabProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState, clearSelection } = useImproveUrlState();
  const isXl = useIsXl();

  const listQuery = useOrgQuery(
    [...queryKeys.artifacts.list(orgId), state.agentId] as const,
    orgId,
    () => learnApi.listArtifacts(orgId!, state.agentId),
  );

  const rows = useMemo(() => {
    const artifacts = listQuery.data?.data?.artifacts ?? [];
    return artifacts
      .map((a) => toRow(a as Record<string, unknown>))
      .filter((r) => r.id);
  }, [listQuery.data]);

  const filtered = useMemo(() => {
    const q = (state.q ?? "").trim().toLowerCase();
    return rows.filter((r) => {
      if (state.planId && r.planId && r.planId !== state.planId) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.kind ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, state.q, state.planId]);

  const selected =
    filtered.find((r) => r.id === state.artifactId) ??
    rows.find((r) => r.id === state.artifactId) ??
    null;

  const rawSelected = useMemo(() => {
    const artifacts = listQuery.data?.data?.artifacts ?? [];
    return (
      artifacts.find((a) => {
        const id = String(
          (a as Record<string, unknown>).id ??
            (a as Record<string, unknown>).artifact_id ??
            "",
        );
        return id === state.artifactId;
      }) ?? null
    );
  }, [listQuery.data, state.artifactId]);

  const gate = evaluateEvidenceGate({
    refs: {
      issueId: state.issueId,
      experimentId: state.experimentId,
      alertId: state.alertId,
      evidence:
        rawSelected && typeof rawSelected === "object"
          ? ((rawSelected as Record<string, unknown>).evidence as
              | Record<string, unknown>
              | undefined) ??
            ((rawSelected as Record<string, unknown>).refs as
              | Record<string, unknown>
              | undefined)
          : null,
    },
    artifactSelected: Boolean(selected),
    artifactSealed: selected
      ? selected.status !== "draft" && selected.status !== "generating"
      : false,
    gitConnected: true,
    forPr: true,
  });

  const promoteMutation = useOrgMutation(
    (artifactId: string) => learnApi.promoteArtifact(orgId!, artifactId),
    {
      invalidateKeys: [
        queryKeys.artifacts.list(orgId),
        queryKeys.improve.all,
      ],
      onSuccess: (res) => {
        if (res.data?.promoted === false) {
          toast.error(t("artifacts.promoteFailed"));
          return;
        }
        setState({ tab: "promotions" });
      },
      onError: (err) => {
        toast.error(err.message || t("artifacts.promoteFailed"));
      },
    },
  );

  const detailOpen = Boolean(state.artifactId);
  const diff =
    rawSelected && typeof rawSelected === "object"
      ? String(
          (rawSelected as Record<string, unknown>).diff ??
            (rawSelected as Record<string, unknown>).diff_unified ??
            (rawSelected as Record<string, unknown>).payload ??
            "",
        )
      : "";

  const primary: "promote" | "pr" | "none" = !gate.pass
    ? "none"
    : "promote";

  const detailBody = selected ? (
    <div className="space-y-4 p-4" data-testid="artifact-detail">
      <EvidenceGateBanner gate={gate} />
      <ShowCodePanel diff={diff || null} />
      <OutcomeTriad
        canMutate={canMutate}
        primary={primary}
        promoteDisabled={!gate.pass || promoteMutation.isPending}
        promoteDisabledReason={gate.reasons.join(" ")}
        onPromote={() => void promoteMutation.mutateAsync(selected.id)}
        prDisabled={!gate.pass}
        prDisabledReason={
          gate.reasons[0] ||
          (isRepoNotConnected(null) ? REPO_NOT_CONNECTED_MESSAGE : undefined)
        }
        onOpenPr={() => {
          if (selected.planId) {
            window.location.href = `/improve/plans/${encodeURIComponent(selected.planId)}?panel=pr`;
          }
        }}
        costHref={`/cost?tab=advisor${selected.agentId ? `&agentId=${encodeURIComponent(selected.agentId)}` : ""}`}
      />
      <RelatedStrip
        links={[
          selected.planId
            ? {
                href: `/improve/plans/${encodeURIComponent(selected.planId)}`,
                label: t("related.plan"),
              }
            : null,
          {
            href: `/improve?tab=promotions`,
            label: t("related.promotions"),
          },
          {
            href: `/improve?tab=ledger${selected.agentId ? `&agentId=${encodeURIComponent(selected.agentId)}` : ""}`,
            label: t("related.ledger"),
          },
        ].filter(Boolean) as Array<{ href: string; label: string }>}
      />
    </div>
  ) : null;

  return (
    <div data-testid="improve-artifacts-tab">
      <ResourcePageShell
        table={
          <QueryState
            loading={listQuery.isLoading}
            error={listQuery.error}
            data={filtered}
            onRetry={() => void listQuery.refetch()}
            isEmpty={(r) => r.length === 0}
            filtersActive={Boolean(state.q || state.planId || state.agentId)}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={Package}
                title={t("artifacts.empty.title")}
                description={t("artifacts.empty.body")}
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/improve?tab=queue">
                      {t("artifacts.empty.cta")}
                    </Link>
                  </Button>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                title={t("artifacts.filterEmpty.title")}
                description={t("artifacts.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() =>
                      setState({
                        q: undefined,
                        planId: undefined,
                        agentId: undefined,
                      })
                    }
                  >
                    {t("artifacts.filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(data) => (
              <ArtifactVersionTable
                rows={data}
                selectedId={state.artifactId}
                onSelect={(id) => setState({ artifactId: id })}
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

      {!selected && !listQuery.isLoading ? (
        <Panel tone="flat" padding="md" className="mt-2 xl:hidden">
          <p className="text-sm text-[var(--text-muted)]">
            {t("artifacts.selectPrompt")}
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
