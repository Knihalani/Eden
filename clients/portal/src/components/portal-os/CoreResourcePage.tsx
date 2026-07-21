"use client";

import type { ReactNode } from "react";
import { PageContent, type PageContentProps } from "@/components/layout/page-content";
import { ResourcePageShell } from "./ResourcePageShell";

/**
 * Master–detail URL contract (UX-P0-07 / Laminar §B.1).
 *
 * Canonical keys (write these; clear aliases on set):
 * | Resource / concern | Canonical     | Aliases (read)              |
 * |--------------------|---------------|-----------------------------|
 * | Trace detail       | `traceId`     | `trace_id`, `trace`         |
 * | Span in detail     | `spanId`      | `span_id`, `span`           |
 * | Saved table view   | `viewId`      | `savedView` (legacy)        |
 * | Hub lens tab       | `view`        | — (traces\|spans\|sessions) |
 * | Issue peek         | `issueId`     | —                           |
 * | Alert peek         | `alertId`     | —                           |
 * | Agent peek         | `agentId`     | —                           |
 * | Debug session peek | `sessionId`   | — (also traces hub filter)  |
 *
 * Opening a row sets the id param; the list slot stays mounted in
 * ResourcePageShell. Closing clears the id (and spanId when present).
 * Do not navigate away to `/observability?trace_id=` as the happy path.
 */
export const MASTER_DETAIL_QUERY_KEYS = {
  traceId: ["traceId", "trace_id", "trace"] as const,
  spanId: ["spanId", "span_id", "span"] as const,
  /** Saved views — never clash with hub `view=` tab. */
  viewId: ["viewId", "savedView"] as const,
  issueId: ["issueId"] as const,
  alertId: ["alertId"] as const,
  /** Agents list peek — full leaf stays at `/agents/[id]`. */
  agentId: ["agentId"] as const,
  sessionId: ["sessionId"] as const,
  experimentId: ["experimentId"] as const,
  promotionId: ["promotionId"] as const,
  artifactId: ["artifactId"] as const,
  /** Datasets list peek — full spreadsheet stays at `/datasets/[id]`. */
  datasetId: ["datasetId"] as const,
} as const;

export type MasterDetailKind = keyof typeof MASTER_DETAIL_QUERY_KEYS;

/** Read first non-empty value among canonical + aliases. */
export function readMasterDetailParam(
  searchParams: URLSearchParams | { get: (key: string) => string | null },
  kind: MasterDetailKind,
): string | undefined {
  const keys = MASTER_DETAIL_QUERY_KEYS[kind];
  for (const key of keys) {
    const v = searchParams.get(key);
    if (v) return v;
  }
  return undefined;
}

/** Set canonical key and strip aliases so share links stay clean. */
export function writeMasterDetailParam(
  params: URLSearchParams,
  kind: MasterDetailKind,
  value: string | undefined,
): void {
  const keys = MASTER_DETAIL_QUERY_KEYS[kind];
  const [canonical, ...aliases] = keys;
  for (const alias of aliases) params.delete(alias);
  if (!value) params.delete(canonical);
  else params.set(canonical, value);
}

/** Clear detail selection (trace + span) without touching filters / view. */
export function clearTraceDetailParams(params: URLSearchParams): void {
  writeMasterDetailParam(params, "traceId", undefined);
  writeMasterDetailParam(params, "spanId", undefined);
}

export interface CoreResourcePageProps {
  size?: PageContentProps["size"];
  className?: string;
  /** Optional when the surface is embedded under a hub that already owns identity. */
  header?: ReactNode;
  toolbar?: ReactNode;
  kpiStrip?: ReactNode;
  table: ReactNode;
  detail?: ReactNode;
  bulkBar?: ReactNode;
}

/**
 * U18 migration helper — PageContent + ResourcePageShell on one contract.
 * Header and toolbar are separate slots so list hubs do not double-pad
 * (PageHeader margin stacked inside a shared toolbar space-y).
 *
 * Master–detail: pass `detail` when an id query param is set; keep `table`
 * always rendered so the list stays mounted (Laminar-grade split/drawer).
 */
export function CoreResourcePage({
  size = "default",
  className,
  header,
  toolbar,
  kpiStrip,
  table,
  detail,
  bulkBar,
}: CoreResourcePageProps) {
  return (
    <PageContent size={size} className={className}>
      <ResourcePageShell
        header={header}
        toolbar={toolbar}
        kpiStrip={kpiStrip}
        table={table}
        detail={detail}
        bulkBar={bulkBar}
      />
    </PageContent>
  );
}
