"use client";

import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type RcaPanelProps = {
  title?: string;
  summary?: string | null;
  findings?: string[];
  markdown?: string | null;
  emptyLabel?: string;
  className?: string;
};

export function RcaPanel({
  title = "RCA",
  summary,
  findings,
  markdown,
  emptyLabel = "No RCA yet.",
  className,
}: RcaPanelProps) {
  const hasBody =
    Boolean(summary?.trim()) ||
    Boolean(markdown?.trim()) ||
    (findings != null && findings.length > 0);

  return (
    <Panel
      tone="flat"
      padding="md"
      className={cn("space-y-2", className)}
      data-testid="rca-panel"
    >
      <h3 className="text-sm font-medium text-[var(--text-primary)]">{title}</h3>
      {!hasBody ? (
        <p className="text-sm text-[var(--text-muted)]">{emptyLabel}</p>
      ) : (
        <>
          {summary?.trim() ? (
            <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
              {summary}
            </p>
          ) : null}
          {markdown?.trim() ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 font-mono text-xs text-[var(--text-secondary)]">
              {markdown}
            </pre>
          ) : null}
          {findings && findings.length > 0 ? (
            <ul className="list-inside list-disc text-sm text-[var(--text-secondary)]">
              {findings.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Panel>
  );
}
