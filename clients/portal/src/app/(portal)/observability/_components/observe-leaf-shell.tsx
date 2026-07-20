"use client";

/**
 * Shared Advanced-leaf identity for /observability/* surfaces.
 * Keeps eyebrow + framing consistent so deep-links read as Traces
 * Advanced tools — not competing Observe hubs. PageContent still
 * owns padding; EmbeddedSurface suppresses this header when nested.
 */

import { PageHeader, type PageHeaderProps } from "@/components/layout/page-header";

export const OBSERVE_LEAF_DESCRIPTION =
  "Advanced under Traces — use Traces More / facets when nested; not a separate Observe hub.";

export function ObserveLeafHeader({
  description = OBSERVE_LEAF_DESCRIPTION,
  eyebrow = "Observe",
  ...props
}: PageHeaderProps) {
  return <PageHeader eyebrow={eyebrow} description={description} {...props} />;
}
