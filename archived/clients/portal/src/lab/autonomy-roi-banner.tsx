"use client";

import Link from "next/link";
import { api } from "@/lib/api/resources";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SHELL_QUERY } from "@/lib/portal-query";

/**
 * Surfaces would-have-healed / budget pause near Improve + Home.
 * Fail soft — never blocks the page.
 */
export function AutonomyRoiBanner({ className }: { className?: string }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const policyQuery = useOrgQuery(
    queryKeys.portal.autonomyPolicy(orgId),
    orgId,
    async () => (await api.getAutonomyPolicy(orgId!)).data,
    SHELL_QUERY,
  );

  const policy = policyQuery.data;
  if (!policy || policyQuery.isError) return null;

  const healOn = Boolean(policy.auto_runtime_heal);
  const would = policy.would_have_healed_count ?? 0;
  const budget = policy.budget;
  const budgetPaused = Boolean(budget && !budget.within_budget);

  if (healOn && !budgetPaused) return null;
  if (!healOn && would <= 0 && !budgetPaused) return null;

  return (
    <div
      className={
        className ??
        "border-b border-[var(--line)] px-5 py-3 sm:px-6"
      }
    >
      <p className="type-meta text-[var(--text)]">
        {!healOn && would > 0 ? (
          <>
            Eden would have fixed {would} reversible heal
            {would === 1 ? "" : "s"} in the last 7 days while self-heal was
            off.{" "}
            <Link
              href="/settings#autonomy-settings"
              className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              Turn self-heal on
            </Link>
          </>
        ) : null}
        {budgetPaused ? (
          <>
            {!healOn && would > 0 ? " · " : null}
            Maintenance budget exhausted today.{" "}
            <Link
              href="/settings#autonomy-audit"
              className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              View audit
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
