"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type OutcomeTriadProps = {
  promoteLabel?: string;
  onPromote?: () => void;
  promoteDisabled?: boolean;
  promoteDisabledReason?: string;
  costHref?: string;
  costLabel?: string;
  prLabel?: string;
  onOpenPr?: () => void;
  prHref?: string | null;
  prDisabled?: boolean;
  prDisabledReason?: string;
  /** One solid CTA among promote | cost | pr */
  primary?: "promote" | "cost" | "pr" | "none";
  canMutate?: boolean;
  className?: string;
};

export function OutcomeTriad({
  promoteLabel = "Promote",
  onPromote,
  promoteDisabled,
  promoteDisabledReason,
  costHref = "/cost?tab=advisor",
  costLabel = "Cost advisor",
  prLabel = "Open PR",
  onOpenPr,
  prHref,
  prDisabled,
  prDisabledReason,
  primary = "promote",
  canMutate = true,
  className,
}: OutcomeTriadProps) {
  const promoteVariant = primary === "promote" ? "default" : "secondary";
  const costVariant = primary === "cost" ? "default" : "secondary";
  const prVariant = primary === "pr" ? "default" : "secondary";

  return (
    <Panel
      tone="flat"
      padding="md"
      className={cn("space-y-3", className)}
      data-testid="outcome-triad"
    >
      <h3 className="text-sm font-medium text-[var(--text-primary)]">
        Outcomes
      </h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <p className="text-xs text-[var(--text-muted)]">Artifact</p>
          {canMutate ? (
            <Button
              type="button"
              size="sm"
              variant={promoteVariant}
              className="min-h-11 w-full"
              disabled={promoteDisabled || !onPromote}
              title={promoteDisabledReason}
              onClick={onPromote}
              data-testid="outcome-promote"
            >
              {promoteLabel}
            </Button>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">View only</p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-[var(--text-muted)]">Optimization</p>
          <Button
            asChild
            size="sm"
            variant={costVariant}
            className="min-h-11 w-full"
            data-testid="outcome-cost"
          >
            <Link href={costHref}>{costLabel}</Link>
          </Button>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-[var(--text-muted)]">Pull request</p>
          {prHref ? (
            <Button
              asChild
              size="sm"
              variant={prVariant}
              className="min-h-11 w-full"
              data-testid="outcome-pr-view"
            >
              <a href={prHref} target="_blank" rel="noopener noreferrer">
                View PR
              </a>
            </Button>
          ) : canMutate ? (
            <Button
              type="button"
              size="sm"
              variant={prVariant}
              className="min-h-11 w-full"
              disabled={prDisabled || !onOpenPr}
              title={prDisabledReason}
              onClick={onOpenPr}
              data-testid="outcome-pr-open"
            >
              {prLabel}
            </Button>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">View only</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
