"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { improveHref } from "@/lib/portal-cross-links";

/**
 * Wave 6.3 — Failed guardrail / red-team finding → Improve queue scent.
 * Links to the queue hub (no issue id from guardrails surfaces).
 */
export function GuardrailsQueueBridge({
  reason,
  testId = "guardrails-queue-bridge",
}: {
  reason: string;
  testId?: string;
}) {
  return (
    <Panel
      tone="tint"
      padding="sm"
      className="flex flex-wrap items-center justify-between gap-space-2"
      data-testid={testId}
      data-wave6-improve-queue-bridge="ready"
    >
      <p className="text-sm text-[var(--text-primary)]">{reason}</p>
      <Button asChild variant="outline" className="min-h-11" size="sm">
        <Link href={improveHref()} data-testid={`${testId}-link`}>
          Open Improve queue
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </Button>
    </Panel>
  );
}
