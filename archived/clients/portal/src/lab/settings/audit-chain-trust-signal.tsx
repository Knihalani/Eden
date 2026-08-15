"use client";

import { StatusChip } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { portalApi } from "@/lib/api/portal";
import { queryKeys } from "@/lib/query-keys";
import { SHELL_QUERY } from "@/lib/portal-query";

/**
 * FEAT-110 — live trust signal for ``AgentAuditLedgerWriter.verify_chain``.
 * Prefers ``POST /orgs/{id}/compliance/verify`` (hash-chained agent audit
 * ledger). Falls back gracefully when the feature flag / route is unavailable.
 */
export function AuditChainTrustSignal({
  className,
}: {
  className?: string;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const query = useOrgQuery(
    queryKeys.portal.auditChainVerify(orgId),
    orgId,
    async () => {
      const res = await portalApi.verifyAuditChain(orgId!);
      const data = res.data ?? {};
      return {
        total_rows: Number(data.total_rows ?? 0),
        ok_rows: Number(data.ok_rows ?? 0),
        broken_rows: Number(data.broken_rows ?? 0),
        verified: Boolean(
          data.verified ??
            (Number(data.broken_rows ?? 0) === 0 &&
              Number(data.ok_rows ?? 0) > 0),
        ),
      };
    },
    { ...SHELL_QUERY, staleTime: 60_000 },
  );

  if (!orgId) return null;

  if (query.isLoading) {
    return (
      <span className={className}>
        <StatusChip tone="neutral">Checking audit log…</StatusChip>
      </span>
    );
  }

  if (query.isError || !query.data) {
    return (
      <span className={className} title="Could not verify audit chain">
        <StatusChip tone="neutral">Audit log unavailable</StatusChip>
      </span>
    );
  }

  const { total_rows, broken_rows, ok_rows, verified } = query.data;
  // Zero-state — not a green false positive.
  if (total_rows === 0) {
    return (
      <span
        className={className}
        title="No chained audit ledger rows yet"
      >
        <StatusChip tone="neutral">No audit events yet</StatusChip>
      </span>
    );
  }

  return (
    <span
      className={className}
      data-testid="audit-chain-trust"
      title={`${ok_rows}/${total_rows} rows ok${
        broken_rows ? ` · ${broken_rows} broken` : ""
      }`}
    >
      <StatusChip tone={verified ? "ok" : "fail"}>
        {verified ? "Audit log verified" : `Audit log broken · ${broken_rows}`}
      </StatusChip>
    </span>
  );
}
