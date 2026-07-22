"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

export interface ComingSoonPanelProps {
  surfaceId: string;
  surfaceLabel: string;
  docFile?: string;
}

export function ComingSoonPanel({
  surfaceId,
  surfaceLabel,
  docFile,
}: ComingSoonPanelProps) {
  const t = useTranslations("comingSoon");

  return (
    <div className="mx-auto max-w-lg space-y-4 py-4">
      <Panel tone="flat" padding="lg" className="space-y-3">
        <p className="text-xs font-medium text-[var(--accent)]">
          {t("eyebrow")}
        </p>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">
          {surfaceLabel}
        </h1>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          {t("body", { surface: surfaceLabel })}
        </p>
        {docFile ? (
          <p className="font-mono text-xs text-[var(--text-muted)]">
            {t("docHint", { doc: docFile })}
          </p>
        ) : (
          <p className="font-mono text-xs text-[var(--text-muted)]">
            {t("docHintFallback", { id: surfaceId })}
          </p>
        )}
        <Button variant="secondary" size="sm" asChild>
          <Link href="/dashboard">{t("back")}</Link>
        </Button>
      </Panel>
    </div>
  );
}
