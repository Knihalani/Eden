"use client";

import Link from "next/link";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { CodeChip } from "@/components/ui/code-chip";
import { Panel } from "@/components/ui/panel";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import type { LedgerEntryRow } from "./ledger-timeline";
import { RelatedStrip } from "./related-strip";

export type LedgerEntryDetailProps = {
  entry: LedgerEntryRow | null;
  open: boolean;
  onClose: () => void;
  mobileDrawer?: boolean;
};

export function LedgerEntryDetail({
  entry,
  open,
  onClose,
  mobileDrawer,
}: LedgerEntryDetailProps) {
  if (!entry) return null;

  const refs = entry.refs ?? {};
  const planId = str(refs.planId ?? refs.plan_id);
  const artifactId = str(refs.artifactId ?? refs.artifact_id);
  const prUrl = str(refs.prUrl ?? refs.pr_url);
  const issueId = str(refs.issueId ?? refs.issue_id);
  const promotionId = str(refs.promotionId ?? refs.promotion_id);

  const related = [
    planId
      ? {
          href: `/improve/plans/${encodeURIComponent(planId)}`,
          label: `Plan ${planId}`,
        }
      : null,
    artifactId
      ? {
          href: `/improve?tab=artifacts&artifactId=${encodeURIComponent(artifactId)}`,
          label: `Artifact ${artifactId}`,
        }
      : null,
    promotionId
      ? {
          href: `/improve?tab=promotions&promotionId=${encodeURIComponent(promotionId)}`,
          label: `Promotion ${promotionId}`,
        }
      : null,
    issueId
      ? {
          href: `/issues?issueId=${encodeURIComponent(issueId)}`,
          label: `Issue ${issueId}`,
        }
      : null,
    {
      href: "/improve?tab=queue",
      label: "Improve queue",
    },
  ].filter(Boolean) as Array<{ href: string; label: string }>;

  const primaryHref = prUrl
    ? prUrl
    : planId
      ? `/improve/plans/${encodeURIComponent(planId)}`
      : artifactId
        ? `/improve?tab=artifacts&artifactId=${encodeURIComponent(artifactId)}`
        : "/improve?tab=queue";

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={entry.title}
      mobileDrawer={mobileDrawer}
      headerActions={
        entry.status ? <StatusBadge status={entry.status} /> : undefined
      }
    >
      <div className="space-y-4 p-4" data-testid="ledger-entry-detail">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={entry.kind} />
          <CodeChip size="sm">{entry.id}</CodeChip>
          {entry.agentId ? <CodeChip size="sm">{entry.agentId}</CodeChip> : null}
        </div>

        <Panel tone="flat" padding="md" className="space-y-2">
          {entry.actor ? (
            <p className="text-sm text-[var(--text-secondary)]">
              Actor: {entry.actor}
            </p>
          ) : null}
          {entry.createdAt ? (
            <p className="text-sm text-[var(--text-muted)]">
              {new Date(entry.createdAt).toLocaleString()}
            </p>
          ) : null}
          {entry.raw != null ? (
            <pre className="max-h-48 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2 font-mono text-xs">
              {typeof entry.raw === "string"
                ? entry.raw
                : JSON.stringify(entry.raw, null, 2)}
            </pre>
          ) : null}
        </Panel>

        <div>
          {prUrl ? (
            <Button asChild size="sm" className="min-h-11">
              <a href={prUrl} target="_blank" rel="noopener noreferrer">
                Open PR
              </a>
            </Button>
          ) : (
            <Button asChild size="sm" className="min-h-11">
              <Link href={primaryHref}>
                {planId ? "Open plan" : "Open Improve"}
              </Link>
            </Button>
          )}
        </div>

        <RelatedStrip links={related} />
      </div>
    </DetailPanelShell>
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
