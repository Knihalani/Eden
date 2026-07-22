"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import type { Diagnosis } from "@/lib/agent-health";
import { cn } from "@/lib/utils";

export type DiagnosisStripProps = {
  diagnosis: Diagnosis;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  isHealthy?: boolean;
  live?: boolean;
  /** Override default dashboard test id for Observe hubs. */
  testId?: string;
  /** Optional label override (defaults to dashboard.diagnosis.label). */
  label?: string;
  /** Optional title override when not using diagnosis summary i18n. */
  title?: string;
  /** Optional supporting line override. */
  description?: string;
  /** Optional CTA label override. */
  ctaLabel?: string;
};

/**
 * Shared diagnosis / findings strip (Dashboard + Observe detail).
 * Dashboard continues to pass `Diagnosis` from agent-health.
 */
export function DiagnosisStrip({
  diagnosis,
  loading,
  error,
  onRetry,
  isHealthy,
  live,
  testId = "dashboard-diagnosis",
  label,
  title,
  description,
  ctaLabel,
}: DiagnosisStripProps) {
  const t = useTranslations("dashboard.diagnosis");
  const titleId = `${testId}-title`;

  if (error) {
    return (
      <Panel
        tone="flat"
        padding="md"
        className="flex flex-col gap-2 border-[var(--warning)]/30 sm:flex-row sm:items-center sm:justify-between"
        data-testid={testId}
        role="alert"
      >
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {t("partialError")}
        </p>
        {onRetry ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            {t("retry")}
          </Button>
        ) : null}
      </Panel>
    );
  }

  const tone = isHealthy ? "ok" : "attention";
  const resolvedCtaLabel =
    ctaLabel ?? (isHealthy ? t("ctaHealthy") : t("ctaReview"));
  const ctaVariant = isHealthy ? "ghost" : "default";
  const resolvedTitle =
    title ??
    (loading
      ? t("checking")
      : t("summary", {
          issues: diagnosis.openIssueCount,
          errors: diagnosis.errorTraceCount,
          hours: diagnosis.windowHours,
        }));
  const resolvedDescription =
    description ??
    (diagnosis.worstAgentName
      ? t("worst", { name: diagnosis.worstAgentName })
      : null);

  return (
    <Panel
      tone="tint"
      padding="md"
      data-testid={testId}
      role="region"
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        tone === "ok"
          ? "border-[var(--border-subtle)]"
          : "border-[var(--warning)]/30",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {isHealthy ? (
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--success)]"
            aria-hidden
          />
        ) : (
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning-strong)]"
            aria-hidden
          />
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {label ?? t("label")}
            </p>
            {live ? (
              <span
                className="inline-flex items-center gap-1 text-xs text-[var(--terminal)]"
                aria-live="polite"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--status-running)]"
                  aria-hidden
                />
                {t("live")}
              </span>
            ) : null}
          </div>
          <h2
            id={titleId}
            className="m-0 text-base font-medium tracking-tight text-[var(--text-primary)]"
          >
            {resolvedTitle}
          </h2>
          {resolvedDescription ? (
            <p className="m-0 text-sm text-[var(--text-secondary)]">
              {resolvedDescription}
            </p>
          ) : null}
        </div>
      </div>
      <Button
        asChild
        size="sm"
        variant={ctaVariant}
        className="min-h-11 shrink-0 self-start sm:self-auto"
      >
        <Link href={diagnosis.primaryHref}>{resolvedCtaLabel}</Link>
      </Button>
    </Panel>
  );
}
