"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { improveHref } from "@/lib/portal-cross-links";

/** Cost anomaly / budget breach → Improve queue scent (Wave 7.5). */
export function CostImproveCrossLink({ reason }: { reason: string }) {
  return (
    <div
      data-testid="cost-improve-crosslink"
      className="flex flex-wrap items-center justify-between gap-space-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-space-4 py-space-3"
    >
      <p className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]">{reason}</p>
      <Button asChild variant="outline" size="sm">
        <Link href={improveHref()}>
          Open Improve queue
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </Button>
    </div>
  );
}
