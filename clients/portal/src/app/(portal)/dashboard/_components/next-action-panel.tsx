"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { CodeChip } from "@/components/ui/code-chip";
import type { FailureRow, NextAction } from "@/lib/agent-health";

type Props = {
  nextAction: NextAction;
  failures: FailureRow[];
};

export function NextActionPanel({ nextAction, failures }: Props) {
  const t = useTranslations("dashboard.nextAction");

  return (
    <aside
      className="space-y-3"
      data-testid="dashboard-next-action"
      aria-label={t("title")}
    >
      <Panel tone="flat" padding="md" className="space-y-3">
        <h2 className="m-0 text-sm font-medium text-[var(--text-primary)]">
          {t("title")}
        </h2>
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {t(`kinds.${nextAction.kind}` as "kinds.connect")}
        </p>
        <Button
          asChild
          size="sm"
          variant={nextAction.kind === "healthy" ? "ghost" : "default"}
          className="min-h-11"
        >
          <Link href={nextAction.href}>
            {t(`cta.${nextAction.kind}` as "cta.connect")}
          </Link>
        </Button>
      </Panel>

      <Panel tone="subtle" padding="md" className="space-y-2">
        <h3 className="m-0 text-sm font-medium text-[var(--text-primary)]">
          {t("failuresTitle")}
        </h3>
        {failures.length === 0 ? (
          <p className="m-0 text-sm text-[var(--text-muted)]">
            {t("failuresEmpty")}
          </p>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {failures.map((f) => (
              <li key={f.traceId} className="text-sm">
                <Link
                  href={`/traces?traceId=${encodeURIComponent(f.traceId)}`}
                  className="inline-flex flex-wrap items-center gap-2 hover:underline"
                >
                  <CodeChip size="sm">{f.traceId.slice(0, 12)}</CodeChip>
                  <span className="text-[var(--text-secondary)] truncate max-w-[14rem]">
                    {f.summary}
                  </span>
                  {f.latencyMs != null ? (
                    <span className="font-mono text-xs text-[var(--text-muted)]">
                      {(f.latencyMs / 1000).toFixed(1)}s
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </aside>
  );
}
