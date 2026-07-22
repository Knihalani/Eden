"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type DatasetCaseRowProps = {
  inputPreview: string;
  expected?: string | null;
  tags?: string[];
  traceId?: string | null;
  className?: string;
};

function previewText(value: string, max = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function DatasetCaseRow({
  inputPreview,
  expected,
  tags = [],
  traceId,
  className,
}: DatasetCaseRowProps) {
  const t = useTranslations("evals");

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-b border-[var(--border-subtle)] py-3 last:border-b-0",
        className,
      )}
      data-testid="dataset-case-row"
    >
      <p className="m-0 text-sm text-[var(--text-primary)]">
        <span className="text-[var(--text-muted)]">{t("case.input")}: </span>
        {previewText(inputPreview || "—")}
      </p>
      {expected ? (
        <p className="m-0 text-xs text-[var(--text-secondary)]">
          <span className="text-[var(--text-muted)]">{t("case.expected")}: </span>
          {previewText(expected, 80)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag} variant="outline" className="rounded-md">
            {tag}
          </Badge>
        ))}
        {traceId ? (
          <Link
            href={`/traces?traceId=${encodeURIComponent(traceId)}&mode=scores`}
            className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
            data-testid="dataset-case-trace-link"
          >
            {t("case.sourceTrace")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
