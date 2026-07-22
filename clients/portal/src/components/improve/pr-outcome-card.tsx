"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CodeChip } from "@/components/ui/code-chip";
import { Panel } from "@/components/ui/panel";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

export type PrOutcomeCardProps = {
  status?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  message?: string | null;
  onOpenPr?: () => void;
  openDisabled?: boolean;
  openDisabledReason?: string;
  canMutate?: boolean;
  className?: string;
};

export function PrOutcomeCard({
  status,
  prUrl,
  prNumber,
  branch,
  message,
  onOpenPr,
  openDisabled,
  openDisabledReason,
  canMutate = true,
  className,
}: PrOutcomeCardProps) {
  return (
    <Panel
      tone="flat"
      padding="md"
      className={cn("space-y-3", className)}
      data-testid="pr-outcome-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          Pull request
        </h3>
        {status ? <StatusBadge status={status} /> : null}
        {prNumber != null ? <CodeChip size="sm">#{prNumber}</CodeChip> : null}
        {branch ? <CodeChip size="sm">{branch}</CodeChip> : null}
      </div>
      {message ? (
        <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {prUrl ? (
          <Button asChild size="sm" className="min-h-11" data-testid="pr-view">
            <a href={prUrl} target="_blank" rel="noopener noreferrer">
              Open provider PR
            </a>
          </Button>
        ) : canMutate ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            disabled={openDisabled || !onOpenPr}
            title={openDisabledReason}
            onClick={onOpenPr}
            data-testid="pr-create"
          >
            Create PR
          </Button>
        ) : null}
        <Button asChild size="sm" variant="secondary" className="min-h-11">
          <Link href="/improve?tab=ledger">View ledger</Link>
        </Button>
      </div>
    </Panel>
  );
}
