"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CodeChip } from "@/components/ui/code-chip";
import {
  severityBadgeKey,
  type FindingRow,
} from "./issue-map";
import { SeverityBadge } from "@/components/ui/status-badge";

type Props = {
  findings: FindingRow[];
  loading?: boolean;
  /** Build /traces?traceId=… href (C3). */
  buildTraceHref: (traceId: string, spanId?: string) => string;
};

/**
 * Embedded Findings strip — stumbles mapped as Findings (not a nav leaf).
 */
export function FindingsStrip({
  findings,
  loading,
  buildTraceHref,
}: Props) {
  const t = useTranslations("issues.findings");

  if (loading) {
    return (
      <div
        className="space-y-2"
        data-testid="findings-strip"
        aria-busy="true"
      >
        <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {t("label")}
        </p>
        <div className="h-10 animate-pulse rounded bg-[var(--bg-tertiary)]" />
        <div className="h-10 animate-pulse rounded bg-[var(--bg-tertiary)]" />
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <div className="space-y-1" data-testid="findings-strip">
        <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {t("label")}
        </p>
        <p className="m-0 text-sm text-[var(--text-secondary)]">{t("empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="findings-strip">
      <p className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {t("label")}
      </p>
      <ul className="m-0 list-none space-y-2 p-0">
        {findings.map((f) => (
          <li
            key={f.findingId}
            className="flex flex-wrap items-start gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2"
            data-testid={`finding-${f.findingId}`}
          >
            <SeverityBadge severity={severityBadgeKey(f.severity)} />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm text-[var(--text-primary)]">{f.message}</p>
              <p className="m-0 mt-0.5 font-mono text-2xs text-[var(--text-muted)]">
                {f.kind}
              </p>
            </div>
            {f.traceId ? (
              <Link
                href={buildTraceHref(f.traceId, f.spanId)}
                className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                data-testid={`finding-trace-${f.findingId}`}
              >
                <CodeChip size="sm">{f.traceId.slice(0, 8)}</CodeChip>
                {f.spanId ? (
                  <span className="text-[var(--text-muted)]">
                    · {f.spanId.slice(0, 6)}
                  </span>
                ) : null}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
