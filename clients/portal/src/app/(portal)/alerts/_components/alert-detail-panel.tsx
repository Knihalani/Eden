"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { CodeChip } from "@/components/ui/code-chip";
import {
  SeverityBadge,
  StatusBadge,
} from "@/components/ui/status-badge";
import type { StatusDescriptor } from "@/lib/types";
import { AlertTriangle, CheckCircle2, Circle, VolumeX } from "lucide-react";
import type { AlertRow } from "./alert-types";
import {
  buildAlertIssueHref,
  buildAlertTraceHref,
  buildCreateIssueHref,
  CHANNELS_SETTINGS_HREF,
  formatRelativeTime,
} from "./alert-links";

const ALERT_STATUS_DESCRIPTORS: Record<string, StatusDescriptor> = {
  open: {
    label: "Open",
    className:
      "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--border-subtle)]",
    icon: AlertTriangle,
  },
  acked: {
    label: "Acked",
    className:
      "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    icon: CheckCircle2,
  },
  silenced: {
    label: "Silenced",
    className:
      "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]",
    icon: VolumeX,
  },
  resolved: {
    label: "Resolved",
    className:
      "bg-[var(--terminal-faint)] text-[var(--terminal)] border-[var(--border-subtle)]",
    icon: Circle,
  },
};

type Props = {
  alert: AlertRow;
  searchParams: URLSearchParams;
  onAcknowledge: (alertId: string) => void;
  acknowledging?: boolean;
  ackError?: string | null;
};

export function AlertDetailPanel({
  alert,
  searchParams,
  onAcknowledge,
  acknowledging,
  ackError,
}: Props) {
  const t = useTranslations("alerts.detail");
  const traceHref = buildAlertTraceHref(alert, searchParams);
  const issueHref = buildAlertIssueHref(alert, searchParams);
  const createIssueHref = buildCreateIssueHref(alert, searchParams);
  const diagnosis =
    alert.message ||
    (typeof alert.payload.summary === "string"
      ? alert.payload.summary
      : null) ||
    t("diagnosisFallback");

  const preferTrace = Boolean(traceHref) && alert.status === "open";
  const primaryIsAck = !preferTrace && alert.status === "open";

  return (
    <div className="space-y-4 p-4" data-testid="alert-detail-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">
            {alert.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={alert.severity} />
            <StatusBadge
              status={alert.status}
              descriptors={ALERT_STATUS_DESCRIPTORS}
            />
          </div>
        </div>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[var(--text-muted)]">{t("firedAt")}</dt>
          <dd className="m-0 font-mono text-[var(--text-secondary)]">
            {formatRelativeTime(alert.firedAt)}
          </dd>
        </div>
        {alert.ruleId ? (
          <div>
            <dt className="text-[var(--text-muted)]">{t("rule")}</dt>
            <dd className="m-0">
              <CodeChip>{alert.ruleId}</CodeChip>
            </dd>
          </div>
        ) : null}
        {alert.agentId ? (
          <div>
            <dt className="text-[var(--text-muted)]">{t("agent")}</dt>
            <dd className="m-0">
              <Link
                href={`/agents/${encodeURIComponent(alert.agentId)}`}
                className="font-mono text-[var(--text-primary)] hover:underline"
              >
                {alert.agentId}
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>

      <Panel
        tone="flat"
        padding="md"
        data-testid="alert-diagnosis"
        className="border-[var(--border-subtle)]"
      >
        <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {t("diagnosisLabel")}
        </p>
        <p className="mt-1 m-0 text-sm text-[var(--text-secondary)]">
          {diagnosis}
        </p>
      </Panel>

      <div className="space-y-2">
        <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {t("evidence")}
        </p>
        <div className="flex flex-wrap gap-2">
          {alert.traceId ? (
            <CodeChip data-testid="alert-evidence-trace">{alert.traceId}</CodeChip>
          ) : null}
          {alert.issueId ? (
            <CodeChip data-testid="alert-evidence-issue">{alert.issueId}</CodeChip>
          ) : null}
          {!alert.traceId && !alert.issueId ? (
            <span className="text-sm text-[var(--text-muted)]">
              {t("noEvidence")}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="alert-detail-actions">
        {traceHref ? (
          <Button
            asChild
            size="sm"
            variant={preferTrace ? "default" : "secondary"}
            className="min-h-11"
            data-testid="alert-open-trace"
          >
            <Link href={traceHref}>{t("openTrace")}</Link>
          </Button>
        ) : null}
        {issueHref ? (
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="min-h-11"
            data-testid="alert-open-issue"
          >
            <Link href={issueHref}>{t("openIssue")}</Link>
          </Button>
        ) : (
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="min-h-11"
            data-testid="alert-create-issue"
          >
            <Link href={createIssueHref}>{t("createIssue")}</Link>
          </Button>
        )}
        {alert.status === "open" ? (
          <Button
            type="button"
            size="sm"
            variant={primaryIsAck ? "default" : "secondary"}
            className="min-h-11"
            disabled={acknowledging}
            onClick={() => onAcknowledge(alert.alertId)}
            data-testid="alert-acknowledge"
          >
            {acknowledging ? t("acking") : t("acknowledge")}
          </Button>
        ) : (
          <p className="m-0 self-center text-sm text-[var(--text-muted)]">
            {t("ackedHint")}
          </p>
        )}
      </div>

      {ackError ? (
        <p className="m-0 text-sm text-[var(--error)]" role="alert">
          {ackError}
        </p>
      ) : null}

      <div className="border-t border-[var(--border-subtle)] pt-3">
        <Link
          href={CHANNELS_SETTINGS_HREF}
          className="text-sm text-[var(--text-secondary)] hover:underline"
          data-testid="alert-channels-link"
        >
          {t("channels")}
        </Link>
      </div>
    </div>
  );
}
