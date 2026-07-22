"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CodeChip } from "@/components/ui/code-chip";
import type { ViolationRow } from "./map-violations";

type Props = {
  open: boolean;
  violation: ViolationRow | null;
  mobileDrawer?: boolean;
  onClose: () => void;
};

function severityVariant(severity: string) {
  if (severity === "block") return "error" as const;
  if (severity === "warn") return "warning" as const;
  return "secondary" as const;
}

export function ViolationDetailPanel({
  open,
  violation,
  mobileDrawer = true,
  onClose,
}: Props) {
  const t = useTranslations("guardrails");

  if (!violation) {
    return (
      <DetailPanelShell
        open={open}
        onClose={onClose}
        title={t("violations.detailTitle")}
        mobileDrawer={mobileDrawer}
      >
        <p className="text-sm text-[var(--text-muted)]">
          {t("violations.selectPrompt")}
        </p>
      </DetailPanelShell>
    );
  }

  const issueHref = violation.traceId
    ? `/issues?q=${encodeURIComponent(violation.traceId)}`
    : "/issues";
  const improveHref = violation.policyId
    ? `/improve?tab=queue&q=${encodeURIComponent(violation.policyId)}`
    : "/improve?tab=queue";
  const traceHref = violation.traceId
    ? `/traces?traceId=${encodeURIComponent(violation.traceId)}`
    : null;

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={t("violations.detailTitle")}
      mobileDrawer={mobileDrawer}
      headerActions={
        <CodeChip size="sm" data-testid="guardrails-violation-id">
          {violation.violationId}
        </CodeChip>
      }
    >
      <div className="space-y-4" data-testid="guardrails-violation-detail">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={severityVariant(String(violation.severity))}>
            {t(
              `severity.${violation.severity === "warn" || violation.severity === "log" ? violation.severity : "block"}`,
            )}
          </Badge>
          <span className="text-sm text-[var(--text-muted)]">
            {violation.createdAt
              ? new Date(violation.createdAt).toLocaleString()
              : "—"}
          </span>
        </div>

        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-[var(--text-muted)]">{t("violations.col.policy")}</dt>
            <dd className="text-[var(--text-primary)]">
              {violation.policyId ? (
                <CodeChip size="sm">{violation.policyId}</CodeChip>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">{t("violations.col.agent")}</dt>
            <dd className="text-[var(--text-primary)]">
              {violation.agentId ? (
                <Link
                  href={`/agents/${encodeURIComponent(violation.agentId)}`}
                  className="text-[var(--accent)] hover:underline"
                >
                  {violation.agentId}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">{t("violations.col.action")}</dt>
            <dd className="text-[var(--text-primary)]">{violation.action}</dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">{t("violations.payload")}</dt>
            <dd className="mt-1 whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 font-mono text-xs text-[var(--text-secondary)]">
              {violation.payload || t("violations.noPayload")}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-3">
          {traceHref ? (
            <Button
              asChild
              type="button"
              className="min-h-11"
              data-testid="guardrails-open-trace"
            >
              <Link href={traceHref}>{t("violations.openTrace")}</Link>
            </Button>
          ) : null}
          <Button
            asChild
            type="button"
            variant="secondary"
            className="min-h-11"
            data-testid="guardrails-open-issue"
          >
            <Link href={issueHref}>{t("violations.createIssue")}</Link>
          </Button>
          <Button
            asChild
            type="button"
            variant="secondary"
            className="min-h-11"
            data-testid="guardrails-open-improve"
          >
            <Link href={improveHref}>{t("violations.createPlan")}</Link>
          </Button>
          <Button asChild type="button" variant="ghost" className="min-h-11">
            <Link href="/alerts?tab=rules">{t("violations.relatedAlerts")}</Link>
          </Button>
        </div>
      </div>
    </DetailPanelShell>
  );
}
