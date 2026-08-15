"use client";

import Link from "next/link";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { artifactsApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { formatRelativeTime } from "@/lib/format";
import { StatusChip } from "@/components/ds/primitives";

/** FEAT-157 — recent artifact demotions from EvidenceGate + archived nudges. */
export function DemotionActivityPanel({
  orgId,
  agentId,
  compact = false,
}: {
  orgId: string;
  agentId?: string;
  compact?: boolean;
}) {
  const listQuery = useOrgQuery(
    queryKeys.artifacts.demotions(orgId, { agentId }),
    orgId,
    () =>
      artifactsApi.listDemotions(orgId, {
        agentId: agentId && agentId !== "all" ? agentId : undefined,
      }),
    { ...SHELL_QUERY, enabled: Boolean(orgId) },
  );
  const items = listQuery.data ?? [];

  return (
    <section className={compact ? undefined : "mt-5 border-t border-[var(--line)] pt-5"}>
      <div className="min-w-0">
        <h3 className="type-ui text-[var(--text-secondary)]">Demotion activity</h3>
        {!compact ? (
          <p className="type-meta mt-1">
            Artifacts archived after 7d regression or evidence-gate demotion.
          </p>
        ) : (
          <p className="type-meta mt-0.5">Recent demotions & archives</p>
        )}
      </div>

      {listQuery.isLoading ? (
        <div
          className="mt-2 space-y-1.5"
          role="status"
          aria-label="Loading demotion history"
        >
          <div className="eden-skeleton-pulse h-3.5 w-1/3 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-3.5 w-2/5 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-3.5 w-1/2 rounded bg-[var(--line)]" />
        </div>
      ) : items.length === 0 ? (
        <p className="type-meta mt-2 text-[var(--text-faint)]">
          No demotion history yet. Promoted artifacts with high stumble rates over 7 days are
          auto-archived by the demotion worker.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.slice(0, compact ? 5 : 15).map((item) => (
            <li key={item.artifact_id} className={compact ? undefined : "ds-panel-muted p-3"}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone="neutral">{item.mode}</StatusChip>
                <span className="type-ui truncate text-[var(--text)]">
                  {item.name || item.artifact_id}
                </span>
                {item.source === "evidence_gate" ? (
                  <span className="type-meta">evidence gate</span>
                ) : null}
              </div>
              <p className="type-meta mt-1">
                {item.reason}
                {item.demoted_at ? ` · ${formatRelativeTime(item.demoted_at)}` : ""}
              </p>
              {!compact ? (
                <p className="type-meta mt-1">
                  <Link
                    href={`/artifacts?id=${encodeURIComponent(item.artifact_id)}&agent=${encodeURIComponent(item.agent_id)}&mode=archived`}
                    className="underline"
                  >
                    View artifact
                  </Link>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
