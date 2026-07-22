"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { agentsApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeChip } from "@/components/ui/code-chip";
import { LedgerTab } from "@/app/(portal)/improve/_components/ledger-tab";

function AgentLedgerInner() {
  const t = useTranslations("agents");
  const tLedger = useTranslations("agents.ledger");
  const params = useParams<{ id: string }>();
  const agentId = decodeURIComponent(params.id);
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const agentQuery = useOrgQuery(
    queryKeys.agents.detail(orgId, agentId),
    orgId,
    () => agentsApi.get(orgId!, agentId),
  );

  const name = agentQuery.data?.name || agentId;

  return (
    <div className="mx-auto max-w-7xl space-y-4" data-testid="agent-ledger">
      <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-muted)]">
        <Link href="/agents" className="hover:text-[var(--text-primary)]">
          {t("title")}
        </Link>
        <span className="mx-1.5">/</span>
        <Link
          href={`/agents/${encodeURIComponent(agentId)}`}
          className="hover:text-[var(--text-primary)]"
        >
          {name}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-[var(--text-secondary)]">{tLedger("crumb")}</span>
      </nav>

      <PageHeader
        title={tLedger("title")}
        subtitle={tLedger("subtitle", { name })}
      />

      <p className="text-sm text-[var(--text-muted)]">
        <CodeChip size="sm">{agentId}</CodeChip>
      </p>

      <LedgerTab lockedAgentId={agentId} />
    </div>
  );
}

export default function AgentLedgerPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      <AgentLedgerInner />
    </Suspense>
  );
}
