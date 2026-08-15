"use client";

import { api, type AutonomyAuditEntry } from "@/lib/api/resources";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SETTINGS_QUERY } from "@/lib/portal-query";
import { formatRelativeTime } from "@/lib/format";
import { QueryErrorPanel } from "@/components/shell/query-error-panel";
import { AuditChainTrustSignal } from "@/lab/settings/audit-chain-trust-signal";

type AutonomyBudgetPayload = {
  budget?: {
    within_budget?: boolean;
    spent_usd?: number;
    limit_usd?: number;
  };
  patches?: {
    used_today?: number;
    max_per_day?: number;
  };
  suppressed_count?: number;
};

/**
 * Read-only autonomy audit + budget — required companion to heal-default-on.
 */
export function AutonomyAuditCard() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const auditQuery = useOrgQuery(
    queryKeys.portal.autonomyAudit(orgId),
    orgId,
    async () => (await api.getAutonomyAudit(orgId!, 40)).data,
    SETTINGS_QUERY,
  );

  const budgetQuery = useOrgQuery(
    queryKeys.portal.autonomyBudget(orgId),
    orgId,
    async () => (await api.getAutonomyBudget(orgId!)).data as AutonomyBudgetPayload,
    SETTINGS_QUERY,
  );

  if (auditQuery.isError && budgetQuery.isError) {
    return (
      <section id="autonomy-audit" className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
        <QueryErrorPanel
          title="Couldn’t load autonomy audit"
          error={auditQuery.error ?? budgetQuery.error}
          onRetry={() => {
            void auditQuery.refetch();
            void budgetQuery.refetch();
          }}
        />
      </section>
    );
  }

  const entries: AutonomyAuditEntry[] = auditQuery.data?.entries ?? [];
  const budget = budgetQuery.data;
  const loading = auditQuery.isLoading && budgetQuery.isLoading;

  return (
    <section id="autonomy-audit" className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="type-label">Autonomy audit</p>
        <AuditChainTrustSignal />
      </div>
      <p className="type-meta mt-1">
        Recent allow / deny decisions for runtime heals and maintenance actions.
      </p>

      {budget?.budget ? (
        <p className="type-meta mt-3 text-[var(--text)]">
          Budget ${(budget.budget.spent_usd ?? 0).toFixed(2)} / $
          {(budget.budget.limit_usd ?? 0).toFixed(2)}
          {budget.budget.within_budget === false ? " · paused" : ""}
          {typeof budget.patches?.used_today === "number" &&
          budget.patches.max_per_day ? (
            <>
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              {budget.patches.used_today}/{budget.patches.max_per_day} patches
              today
            </>
          ) : null}
          {typeof budget.suppressed_count === "number" &&
          budget.suppressed_count > 0 ? (
            <>
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              {budget.suppressed_count} budget denials today
            </>
          ) : null}
        </p>
      ) : null}

      {loading ? (
        <p className="type-meta mt-4">Loading ledger…</p>
      ) : entries.length === 0 ? (
        <p className="type-meta mt-4">No autonomy decisions recorded yet.</p>
      ) : (
        <ul className="mt-4 max-h-64 overflow-y-auto border border-[var(--line)]">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-[var(--line)] px-3 py-2 last:border-b-0"
            >
              <span
                className={
                  e.decision === "allow"
                    ? "type-meta text-[var(--success)]"
                    : e.decision === "deny"
                      ? "type-meta text-[var(--error)]"
                      : "type-meta"
                }
              >
                {e.decision}
              </span>
              <span className="type-ui text-[var(--text)]">{e.action}</span>
              <span className="type-meta">{e.tier_applied}</span>
              {e.reason ? (
                <span className="type-meta min-w-0 flex-1 truncate">{e.reason}</span>
              ) : null}
              {e.created_at ? (
                <span className="type-meta text-[var(--text-faint)]">
                  {formatRelativeTime(e.created_at)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
