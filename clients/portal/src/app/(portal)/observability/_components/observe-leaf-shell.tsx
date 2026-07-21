"use client";

/**
 * Shared Advanced-leaf identity for /observability/* and Observe power tools.
 * Deep-links read as Traces Advanced tools — not competing Observe hubs.
 * PageContent still owns padding; EmbeddedSurface suppresses this header when nested.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, type PageHeaderProps } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";

export const OBSERVE_LEAF_DESCRIPTION =
  "Advanced under Traces — use Traces More / facets when nested; not a separate Observe hub.";

/** Wave 10 shell marker — deep-link identity without product-chrome parity. */
export const WAVE10_SHELL_ATTR = {
  "data-wave10-shell": "deep-link",
} as const;

/** Wave 10 power-tool marker — Overflow-only entry; slim header. */
export const WAVE10_POWER_ATTR = {
  "data-wave10-power": "slim",
} as const;

/** Wave 10 quiet facet marker — MCP / decisions under Traces facets. */
export const WAVE10_FACET_ATTR = {
  "data-wave10-facet": "quiet",
} as const;

/** Observe V3 Wave 8 — Replay / Query / Inspector peeled ≤400; Overflow-only. */
export const WAVE_V3_8_POWER_ATTR = {
  "data-wave-v3-8-power": "peeled",
} as const;

export function ObserveLeafHeader({
  description = OBSERVE_LEAF_DESCRIPTION,
  eyebrow = "Observe",
  ...props
}: PageHeaderProps) {
  return <PageHeader eyebrow={eyebrow} description={description} {...props} />;
}

/**
 * Kit Button back-link for standalone deep-links.
 * Hidden under EmbeddedSurface (Traces already owns chrome).
 */
export function ObserveBackToTraces({
  label = "Back to Traces",
}: {
  label?: string;
}) {
  const embedded = useEmbeddedSurface();
  if (embedded) return null;
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="min-h-11 px-0 w-fit -mt-1 mb-1"
      data-testid="observe-back-to-traces"
    >
      <Link href="/traces">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Link>
    </Button>
  );
}
