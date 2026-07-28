"use client";

import type { ReactNode } from "react";
import { PageHeader } from "@/components/ds/primitives";

/**
 * Shared "no workspace selected" render guard.
 *
 * Before this existed, only ``gateway/page.tsx`` distinguished "you have
 * no workspace selected" from "this workspace has zero data" — every
 * other data page fell through to its normal empty state when
 * ``orgId`` was null, which reads as "this workspace has zero data"
 * even though no workspace was ever queried. Use this instead of
 * rendering the page's own empty state whenever ``orgId`` is null.
 */
export function NoWorkspaceGuard({
  title,
  message = "Select a workspace to view this page.",
  meta,
  actions,
}: {
  title: string;
  message?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="ds-page">
      <PageHeader title={title} meta={meta} actions={actions} />
      <p className="type-body px-5 py-8 text-[var(--text-secondary)]">
        {message}
      </p>
    </div>
  );
}
