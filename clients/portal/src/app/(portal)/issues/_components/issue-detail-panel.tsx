"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IssueWorkflowBadge,
  SeverityBadge,
} from "@/components/ui/status-badge";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { DiagnosisStrip } from "@/components/shell/diagnosis-strip";
import { AddToDatasetDialog } from "@/components/evals/add-to-dataset-dialog";
import { FindingsStrip } from "./findings-strip";
import {
  buildCreatePlanHref,
  buildOpenTraceHref,
  formatRelative,
  hasPlanEvidence,
  severityBadgeKey,
  type FindingRow,
  type IssueRow,
} from "./issue-map";

export type IssueDetailBodyProps = {
  issue: IssueRow | null;
  findings: FindingRow[];
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  searchParams: URLSearchParams;
  canMutate: boolean;
  onResolve?: () => void;
  onTriage?: () => void;
  mutating?: boolean;
  /** Full-page mode (no panel chrome). */
  fullPage?: boolean;
};

export function IssueDetailBody({
  issue,
  findings,
  loading,
  error,
  onRetry,
  searchParams,
  canMutate,
  onResolve,
  onTriage,
  mutating,
  fullPage,
}: IssueDetailBodyProps) {
  const t = useTranslations("issues.detail");
  const tEvals = useTranslations("evals.addToDataset");
  const [addToDatasetOpen, setAddToDatasetOpen] = useState(false);

  if (loading && !issue) {
    return (
      <div className="space-y-3 p-4" data-testid="issue-detail-loading">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error && !issue) {
    return (
      <Panel
        tone="flat"
        padding="md"
        className="m-4"
        data-testid="issue-detail-error"
        role="alert"
      >
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {t("loadError")}
        </p>
        {onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2 min-h-11"
            onClick={onRetry}
          >
            {t("retry")}
          </Button>
        ) : null}
      </Panel>
    );
  }

  if (!issue) {
    return (
      <div className="p-4 text-sm text-[var(--text-muted)]" data-testid="issue-detail-empty">
        {t("selectPrompt")}
      </div>
    );
  }

  const primaryTrace = findings.find((f) => f.traceId);
  const enoughEvidence = hasPlanEvidence(findings);
  const openTraceHref = primaryTrace?.traceId
    ? buildOpenTraceHref(
        searchParams,
        primaryTrace.traceId,
        primaryTrace.spanId,
      )
    : null;
  const planHref = buildCreatePlanHref(issue.issueId, findings);
  const evidenceTraceIds = [
    ...new Set(
      findings
        .map((f) => f.traceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  function buildTraceHref(traceId: string, spanId?: string) {
    return buildOpenTraceHref(searchParams, traceId, spanId);
  }

  return (
    <div
      className={fullPage ? "space-y-4" : "space-y-4 p-4"}
      data-testid="issue-detail-body"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">
            {issue.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <IssueWorkflowBadge status={issue.status} />
            <SeverityBadge severity={severityBadgeKey(issue.severity)} />
            {issue.agentId ? (
              <Link
                href={`/agents/${encodeURIComponent(issue.agentId)}`}
                className="font-mono text-xs text-[var(--accent)] hover:underline"
              >
                {issue.agentId}
              </Link>
            ) : null}
          </div>
          <p className="m-0 text-xs text-[var(--text-muted)]">
            {t("meta", {
              occurrences: issue.occurrenceCount,
              updated: formatRelative(issue.lastSeenAt),
              first: formatRelative(issue.firstSeenAt),
            })}
          </p>
        </div>
      </div>

      <DiagnosisStrip
        diagnosis={{
          openIssueCount: 1,
          errorTraceCount: findings.length,
          windowHours: Number(searchParams.get("pastHours") ?? "24") || 24,
          primaryHref: openTraceHref ?? "/traces",
          worstAgentId: issue.agentId ?? undefined,
        }}
        testId="issue-diagnosis"
        label={t("diagnosisLabel")}
        title={issue.title}
        description={t("diagnosisBody", {
          count: issue.occurrenceCount,
          status: issue.status,
        })}
        ctaLabel={openTraceHref ? t("openTrace") : t("openTraces")}
      />

      <FindingsStrip
        findings={findings}
        loading={loading}
        buildTraceHref={buildTraceHref}
      />

      <section className="space-y-2" data-testid="issue-evidence">
        <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {t("evidence")}
        </p>
        {primaryTrace?.traceId ? (
          <ul className="m-0 list-none space-y-1 p-0">
            {findings
              .filter((f) => f.traceId)
              .slice(0, 8)
              .map((f) => (
                <li key={f.findingId}>
                  <Link
                    href={buildTraceHref(f.traceId!, f.spanId)}
                    className="font-mono text-sm text-[var(--accent)] hover:underline"
                  >
                    {f.traceId}
                  </Link>
                </li>
              ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-[var(--text-secondary)]">
            {t("noEvidence")}
          </p>
        )}
      </section>

      {!enoughEvidence ? (
        <Panel
          tone="flat"
          padding="md"
          className="border-[var(--warning)]/30"
          data-testid="issue-not-enough-evidence"
          role="status"
        >
          <p className="m-0 text-sm font-medium text-[var(--text-primary)]">
            {t("notEnoughEvidence")}
          </p>
          <p className="m-0 mt-1 text-sm text-[var(--text-secondary)]">
            {t("notEnoughEvidenceBody")}
          </p>
          <Button asChild size="sm" variant="secondary" className="mt-3 min-h-11">
            <Link href="/traces">{t("openTraces")}</Link>
          </Button>
        </Panel>
      ) : null}

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="issue-detail-actions"
      >
        {canMutate && enoughEvidence ? (
          <Button asChild size="sm" className="min-h-11" data-testid="issue-create-plan">
            <Link href={planHref}>{t("createPlan")}</Link>
          </Button>
        ) : null}
        {canMutate && !enoughEvidence ? (
          <Button
            size="sm"
            disabled
            className="min-h-11"
            title={t("notEnoughEvidence")}
            data-testid="issue-create-plan-disabled"
          >
            {t("createPlan")}
          </Button>
        ) : null}
        {!canMutate && enoughEvidence ? (
          <Button
            size="sm"
            disabled
            className="min-h-11"
            title={t("viewerReadonly")}
            data-testid="issue-create-plan-viewer"
          >
            {t("createPlan")}
          </Button>
        ) : null}
        {openTraceHref ? (
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="min-h-11"
            data-testid="issue-open-trace"
          >
            <Link href={openTraceHref}>{t("openTrace")}</Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="secondary" className="min-h-11">
            <Link href="/traces">{t("openTraces")}</Link>
          </Button>
        )}
        {canMutate && onTriage ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={mutating}
            onClick={onTriage}
            data-testid="issue-triage"
          >
            {t("triage")}
          </Button>
        ) : null}
        {canMutate && onResolve ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={mutating}
            onClick={onResolve}
            data-testid="issue-resolve"
          >
            {t("resolve")}
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost" className="min-h-11">
          <Link
            href={`/issues/${encodeURIComponent(issue.issueId)}`}
            data-testid="issue-open-full"
          >
            {t("openFull")}
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-11"
          onClick={() => setAddToDatasetOpen(true)}
          data-testid="issue-add-to-dataset"
        >
          {tEvals("trigger")}
        </Button>
      </div>

      <AddToDatasetDialog
        open={addToDatasetOpen}
        onOpenChange={setAddToDatasetOpen}
        issueId={issue.issueId}
        traceId={primaryTrace?.traceId}
        spanId={primaryTrace?.spanId}
        evidenceTraceIds={evidenceTraceIds}
        agentId={issue.agentId ?? undefined}
      />
    </div>
  );
}

type PanelProps = IssueDetailBodyProps & {
  open: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  title?: string;
};

export function IssueDetailPanel({
  open,
  onClose,
  onPrev,
  onNext,
  title,
  ...bodyProps
}: PanelProps) {
  const t = useTranslations("issues.detail");

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      if (e.key === "t" && bodyProps.issue) {
        const primary = bodyProps.findings.find((f) => f.traceId);
        if (!primary?.traceId) return;
        e.preventDefault();
        window.location.href = buildOpenTraceHref(
          bodyProps.searchParams,
          primary.traceId,
          primary.spanId,
        );
      }
      if (e.key === "p" && bodyProps.canMutate && bodyProps.issue) {
        if (!hasPlanEvidence(bodyProps.findings)) return;
        e.preventDefault();
        window.location.href = buildCreatePlanHref(
          bodyProps.issue.issueId,
          bodyProps.findings,
        );
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, bodyProps]);

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={title ?? bodyProps.issue?.title ?? t("panelTitle")}
      onPrev={onPrev}
      onNext={onNext}
      mobileDrawer={false}
      className="border border-[var(--border-default)] xl:rounded-lg"
    >
      <IssueDetailBody {...bodyProps} />
    </DetailPanelShell>
  );
}
