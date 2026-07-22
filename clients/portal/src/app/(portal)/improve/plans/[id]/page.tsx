"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  improvePlansApi,
  learnApi,
  type ImprovementPlan,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import {
  isImprovementAgentDisabled,
  isRepoNotConnected,
  IMPROVE_FEATURE_DISABLED_DESCRIPTION,
  REPO_NOT_CONNECTED_MESSAGE,
} from "@/lib/improve-feature";
import {
  IMPROVE_PLAN_PANELS,
  parseImprovePlanPanel,
  type ImprovePlanPanel,
} from "@/lib/improve-url";
import { useImproveUrlState } from "../../_hooks/use-improve-url-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { CodeChip } from "@/components/ui/code-chip";
import { Panel } from "@/components/ui/panel";
import {
  ArtifactVersionTable,
  type ArtifactVersionRow,
  EvidenceGateBanner,
  EvidenceStrip,
  evaluateEvidenceGate,
  OutcomeTriad,
  PrOutcomeCard,
  RcaPanel,
  RelatedStrip,
  ShowCodePanel,
} from "@/components/improve";

function PlanDetailInner() {
  const t = useTranslations("improve");
  const params = useParams<{ id: string }>();
  const planId = decodeURIComponent(params.id);
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");
  const { state, setState } = useImproveUrlState();
  const panel = state.panel ?? "evidence";

  const planQuery = useOrgQuery(
    queryKeys.improve.plan(orgId, planId),
    orgId,
    () => improvePlansApi.getPlan(orgId!, planId),
  );

  const artifactsQuery = useOrgQuery(
    [...queryKeys.artifacts.list(orgId), "plan", planId] as const,
    orgId,
    () => learnApi.listArtifacts(orgId!),
  );

  const plan = planQuery.data?.data?.plan ?? null;

  const artifactRows: ArtifactVersionRow[] = useMemo(() => {
    const artifacts = artifactsQuery.data?.data?.artifacts ?? [];
    const rows: ArtifactVersionRow[] = [];
    for (const a of artifacts) {
      const raw = a as Record<string, unknown>;
      const id = String(raw.id ?? raw.artifact_id ?? "");
      if (!id) continue;
      const rowPlan =
        (typeof raw.plan_id === "string" && raw.plan_id) ||
        (typeof raw.planId === "string" && raw.planId) ||
        "";
      if (rowPlan && rowPlan !== planId) continue;
      rows.push({
        id,
        title: String(raw.title ?? raw.name ?? id),
        kind: raw.kind != null ? String(raw.kind) : undefined,
        version: raw.version as string | number | undefined,
        agentId:
          (typeof raw.agent_id === "string" && raw.agent_id) ||
          plan?.agent_id ||
          null,
        planId,
        status: raw.status != null ? String(raw.status) : undefined,
        gate: raw.gate != null ? String(raw.gate) : undefined,
        createdAt:
          (typeof raw.created_at === "string" && raw.created_at) || null,
      });
    }
    return rows;
  }, [artifactsQuery.data, plan?.agent_id, planId]);

  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>();

  useEffect(() => {
    if (!selectedArtifactId && artifactRows[0]) {
      setSelectedArtifactId(artifactRows[0].id);
    }
  }, [artifactRows, selectedArtifactId]);

  const evidence = plan?.evidence ?? {};
  const issueId =
    typeof evidence.issue_id === "string"
      ? evidence.issue_id
      : typeof evidence.issueId === "string"
        ? evidence.issueId
        : state.issueId;
  const experimentId =
    typeof evidence.experiment_id === "string"
      ? evidence.experiment_id
      : state.experimentId;

  const gate = evaluateEvidenceGate({
    refs: {
      issueId,
      experimentId,
      evidence: plan?.evidence ?? null,
    },
    artifactSelected: Boolean(selectedArtifactId),
    artifactSealed: true,
    gitConnected: true,
    forPr: true,
  });

  const approveMutation = useOrgMutation(
    () => improvePlansApi.approvePlan(orgId!, planId),
    {
      invalidateKeys: [queryKeys.improve.plan(orgId, planId)],
      onSuccess: (res) => {
        const prUrl = res.data?.pr_url;
        if (!prUrl) {
          toast.error(res.data?.message || t("planDetail.prNoUrl"));
          return;
        }
        window.open(prUrl, "_blank", "noopener,noreferrer");
      },
      onError: (err) => {
        if (isImprovementAgentDisabled(err)) {
          toast.error(IMPROVE_FEATURE_DISABLED_DESCRIPTION);
          return;
        }
        if (isRepoNotConnected(err)) {
          toast.error(REPO_NOT_CONNECTED_MESSAGE);
          return;
        }
        toast.error(err.message || t("planDetail.prFailed"));
      },
    },
  );

  const promoteMutation = useOrgMutation(
    (artifactId: string) => learnApi.promoteArtifact(orgId!, artifactId),
    {
      onSuccess: (res) => {
        if (res.data?.promoted === false) {
          toast.error(t("artifacts.promoteFailed"));
          return;
        }
        setState({ tab: "promotions" });
      },
      onError: (err) => toast.error(err.message || t("artifacts.promoteFailed")),
    },
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      if (e.key === "e") {
        e.preventDefault();
        setState({ panel: "evidence" });
      }
      if (e.key === "c") {
        e.preventDefault();
        setState({ panel: "code" });
      }
      if (e.key === "a") {
        e.preventDefault();
        setState({ panel: "artifacts" });
      }
      if (e.key === "p" && canMutate && gate.pass) {
        e.preventDefault();
        void approveMutation.mutateAsync();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [approveMutation, canMutate, gate.pass, setState]);

  function setPanel(next: ImprovePlanPanel) {
    setState({ panel: next });
  }

  const evidenceLinks = [
    issueId
      ? {
          href: `/issues?issueId=${encodeURIComponent(issueId)}`,
          label: `Issue ${issueId}`,
        }
      : null,
    experimentId
      ? {
          href: `/evals?tab=experiments&experimentId=${encodeURIComponent(experimentId)}`,
          label: `Experiment ${experimentId}`,
        }
      : null,
    plan?.source_ref
      ? { href: String(plan.source_ref), label: t("planDetail.source") }
      : null,
    plan?.agent_id
      ? {
          href: `/agents/${encodeURIComponent(plan.agent_id)}`,
          label: plan.agent_id,
        }
      : null,
  ].filter(Boolean) as Array<{ href: string; label: string }>;

  return (
    <div
      className="mx-auto max-w-7xl space-y-4 p-4"
      data-testid="improve-plan-detail"
    >
      <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-muted)]">
        <Link href="/improve" className="hover:text-[var(--text-primary)]">
          {t("title")}
        </Link>
        <span className="mx-1.5">/</span>
        <Link
          href="/improve?tab=plans"
          className="hover:text-[var(--text-primary)]"
        >
          {t("tabs.plans")}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-[var(--text-secondary)]">
          {plan?.title ?? planId}
        </span>
      </nav>

      <QueryState
        loading={planQuery.isLoading}
        error={planQuery.error}
        data={plan}
        onRetry={() => void planQuery.refetch()}
        isEmpty={(p) => !p}
        loadingSlot={<Skeleton className="h-64 w-full" />}
        emptySlot={
          <EmptyState
            title={t("planDetail.missingTitle")}
            description={t("planDetail.missingBody")}
            action={
              <Button asChild size="sm" className="min-h-11">
                <Link href="/improve?tab=plans">{t("tabs.plans")}</Link>
              </Button>
            }
          />
        }
      >
        {(p: ImprovementPlan) => (
          <>
            <PageHeader
              title={p.title}
              subtitle={p.summary || t("planDetail.subtitle")}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={p.status} />
                  {p.agent_id ? <CodeChip size="sm">{p.agent_id}</CodeChip> : null}
                  {canMutate && !p.pr_url ? (
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-11"
                      disabled={!gate.pass || approveMutation.isPending}
                      title={gate.reasons.join(" ")}
                      loading={approveMutation.isPending}
                      onClick={() => void approveMutation.mutateAsync()}
                      data-testid="plan-open-pr"
                    >
                      {t("planDetail.openPr")}
                    </Button>
                  ) : null}
                  {p.pr_url ? (
                    <Button asChild size="sm" className="min-h-11">
                      <a
                        href={p.pr_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("planDetail.viewPr")}
                      </a>
                    </Button>
                  ) : null}
                </div>
              }
            />

            <Tabs
              value={parseImprovePlanPanel(panel)}
              onValueChange={(v) => setPanel(v as ImprovePlanPanel)}
            >
              <TabsList variant="underline" aria-label={t("planDetail.panelsAria")}>
                {IMPROVE_PLAN_PANELS.map((id) => (
                  <TabsTrigger
                    key={id}
                    variant="underline"
                    value={id}
                    className="min-h-11"
                    data-testid={`plan-panel-${id}`}
                  >
                    {t(`planDetail.panels.${id}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div data-testid={`plan-panel-body-${panel}`} className="space-y-4">
              {panel === "evidence" ? (
                <Panel tone="flat" padding="md" className="space-y-3">
                  <EvidenceStrip links={evidenceLinks} />
                  <pre className="max-h-64 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 font-mono text-xs">
                    {JSON.stringify(p.evidence ?? {}, null, 2)}
                  </pre>
                </Panel>
              ) : null}

              {panel === "rca" ? (
                <RcaPanel
                  summary={p.summary}
                  markdown={
                    typeof p.triage_snapshot?.rca === "string"
                      ? p.triage_snapshot.rca
                      : null
                  }
                />
              ) : null}

              {panel === "code" ? (
                <ShowCodePanel
                  diff={p.diff_unified}
                  files={p.files_changed}
                  branch={p.github_branch}
                />
              ) : null}

              {panel === "artifacts" ? (
                <div className="space-y-4">
                  <EvidenceGateBanner gate={gate} />
                  <ArtifactVersionTable
                    rows={artifactRows}
                    selectedId={selectedArtifactId}
                    onSelect={setSelectedArtifactId}
                  />
                </div>
              ) : null}

              {panel === "pr" ? (
                <PrOutcomeCard
                  status={p.status}
                  prUrl={p.pr_url}
                  prNumber={p.pr_number}
                  branch={p.github_branch}
                  canMutate={canMutate}
                  openDisabled={!gate.pass || approveMutation.isPending}
                  openDisabledReason={gate.reasons.join(" ")}
                  onOpenPr={() => void approveMutation.mutateAsync()}
                />
              ) : null}

              {panel === "activity" ? (
                <Panel tone="flat" padding="md" className="space-y-2">
                  <p className="text-sm text-[var(--text-secondary)]">
                    Created {new Date(p.created_at).toLocaleString()}
                  </p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Updated {new Date(p.updated_at).toLocaleString()}
                  </p>
                  {p.approved_at ? (
                    <p className="text-sm text-[var(--text-secondary)]">
                      Approved {new Date(p.approved_at).toLocaleString()}
                      {p.approved_by ? ` by ${p.approved_by}` : ""}
                    </p>
                  ) : null}
                  {p.rejected_at ? (
                    <p className="text-sm text-[var(--text-secondary)]">
                      Rejected {new Date(p.rejected_at).toLocaleString()}
                      {p.rejection_reason ? ` — ${p.rejection_reason}` : ""}
                    </p>
                  ) : null}
                </Panel>
              ) : null}
            </div>

            <OutcomeTriad
              canMutate={canMutate}
              primary={gate.pass ? (p.pr_url ? "promote" : "pr") : "none"}
              promoteDisabled={!gate.pass || !selectedArtifactId}
              promoteDisabledReason={gate.reasons.join(" ")}
              onPromote={
                selectedArtifactId
                  ? () => void promoteMutation.mutateAsync(selectedArtifactId)
                  : undefined
              }
              prHref={p.pr_url}
              prDisabled={!gate.pass}
              prDisabledReason={gate.reasons.join(" ")}
              onOpenPr={() => void approveMutation.mutateAsync()}
              costHref={`/cost?tab=advisor${p.agent_id ? `&agentId=${encodeURIComponent(p.agent_id)}` : ""}`}
            />

            <RelatedStrip
              links={[
                { href: "/improve?tab=queue", label: t("tabs.queue") },
                { href: "/improve?tab=artifacts", label: t("tabs.artifacts") },
                { href: "/improve?tab=ledger", label: t("tabs.ledger") },
                { href: "/cost?tab=advisor", label: t("related.cost") },
              ]}
            />
          </>
        )}
      </QueryState>
    </div>
  );
}

export default function ImprovePlanDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <PlanDetailInner />
    </Suspense>
  );
}
