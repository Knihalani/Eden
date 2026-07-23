"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  type GuardrailKind,
  type GuardrailStatus,
  type GuardrailTab,
} from "@/lab/fixtures/guardrails";
import { PageHeader } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  GuardrailsTabNav,
  parseGuardrailKindFilter,
  parseGuardrailStatusFilter,
  parseGuardrailTab,
} from "@/lab/guardrails/guardrails-chrome";
import dynamic from "next/dynamic";
import { catalogAgents } from "@/lib/portal-catalog";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";

const guardrailsFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const GuardrailsListView = dynamic(
  () =>
    import("@/lab/guardrails/guardrails-list-view").then((m) => ({
      default: m.GuardrailsListView,
    })),
  { loading: () => guardrailsFallback },
);
const GuardrailsDetailView = dynamic(
  () =>
    import("@/lab/guardrails/guardrails-detail-view").then((m) => ({
      default: m.GuardrailsDetailView,
    })),
  { loading: () => guardrailsFallback },
);
const GuardrailsTestView = dynamic(
  () =>
    import("@/lab/guardrails/guardrails-detail-view").then((m) => ({
      default: m.GuardrailsTestView,
    })),
  { loading: () => guardrailsFallback },
);

function LabGuardrailsInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const paramAgent = searchParams.get("agent");
  const paramTab = searchParams.get("tab");
  const paramKind = searchParams.get("kind");
  const paramStatus = searchParams.get("status");

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const policiesQuery = useOrgQuery(
    queryKeys.portal.guardrailPolicies(orgId),
    orgId,
    () => portalApi.guardrailPolicies(orgId!),
  );
  const livePolicies = policiesQuery.data ?? [];

  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();

  const [tab, setTab] = useState<GuardrailTab>(() =>
    parseGuardrailTab(paramTab),
  );
  const [policyId, setPolicyId] = useState("");
  const [kindFilter, setKindFilter] = useState<GuardrailKind | "all">(() =>
    parseGuardrailKindFilter(paramKind),
  );
  const [statusFilter, setStatusFilter] = useState<
    GuardrailStatus | "all"
  >(() => parseGuardrailStatusFilter(paramStatus));
  const [query, setQuery] = useState("");

  const policies = livePolicies;

  useEffect(() => {
    if (paramAgent && paramAgent !== agentId) {
      setAgentId(paramAgent);
    }
  }, [paramAgent, agentId, setAgentId]);

  useEffect(() => {
    setTab(parseGuardrailTab(paramTab));
    setKindFilter(parseGuardrailKindFilter(paramKind));
    setStatusFilter(parseGuardrailStatusFilter(paramStatus));
  }, [paramTab, paramKind, paramStatus]);

  const scoped = useMemo(() => {
    if (agentId === "all") return policies;
    return policies.filter((p) => !p.agentId || p.agentId === agentId);
  }, [policies, agentId]);

  // Keep selection inside agent scope.
  useEffect(() => {
    if (tab !== "policies") return;
    const next =
      scoped.find((p) => p.id === paramId)?.id ??
      scoped.find((p) => p.status === "active")?.id ??
      scoped[0]?.id ??
      "";
    if (next && next !== policyId) setPolicyId(next);
    else if (!next && policyId) setPolicyId("");
     
  }, [agentId, scoped, tab, paramId]);

  const policy = scoped.find((p) => p.id === policyId) ?? scoped[0] ?? null;

  const scopeCounts = useMemo(() => {
    const map: Record<string, number> = {
      all: policies.length,
    };
    for (const a of catalogAgents()) {
      map[a.id] = policies.filter(
        (p) => !p.agentId || p.agentId === a.id,
      ).length;
    }
    return map;
  }, [policies]);

  const changeTab = useCallback(
    (next: GuardrailTab) => {
      setTab(next);
      if (next === "policies") {
        patchQuery({
          tab: null,
          id: policyId || null,
        });
      } else {
        patchQuery({ tab: "test", id: null });
      }
    },
    [patchQuery, policyId],
  );

  const selectPolicy = useCallback(
    (id: string) => {
      setPolicyId(id);
      setTab("policies");
      patchQuery({ tab: null, id });
    },
    [patchQuery],
  );

  const changeKind = useCallback(
    (next: GuardrailKind | "all") => {
      setKindFilter(next);
      patchQuery({ kind: next === "all" ? null : next });
    },
    [patchQuery],
  );

  const changeStatus = useCallback(
    (next: GuardrailStatus | "all") => {
      setStatusFilter(next);
      patchQuery({ status: next === "all" ? null : next });
    },
    [patchQuery],
  );

  if (policiesQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Guardrails" />
        <QueryLoadingPanel label="Loading guardrails…" />
      </div>
    );
  }

  if (policiesQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Guardrails" />
        <QueryErrorPanel
          error={policiesQuery.error}
          onRetry={() => void policiesQuery.refetch()}
        />
      </div>
    );
  }

  const activeCount = scoped.filter((p) => p.status === "active").length;
  const hits24h = scoped.reduce((s, p) => s + p.matchCount24h, 0);
  const meta = (
    <span className="type-meta">
      {scoped.length} polic{scoped.length === 1 ? "y" : "ies"}
      {activeCount > 0 ? ` · ${activeCount} active` : ""}
      {hits24h > 0 ? ` · ${hits24h} hits / 24h` : ""}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Guardrails"
        meta={meta}
        actions={<GuardrailsTabNav value={tab} onChange={changeTab} />}
      />

      {tab === "policies" ? (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[22rem] lg:shrink-0 lg:border-b-0 lg:border-r">
            <GuardrailsListView
              policies={scoped}
              activeId={policy?.id ?? null}
              query={query}
              onQueryChange={setQuery}
              agentId={agentId}
              onAgentChange={setAgentId}
              kindFilter={kindFilter}
              onKindFilter={changeKind}
              statusFilter={statusFilter}
              onStatusFilter={changeStatus}
              onSelect={selectPolicy}
              counts={scopeCounts}
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <GuardrailsDetailView policy={policy} />
          </div>
        </div>
      ) : (
        <GuardrailsTestView
          agentId={agentId}
          onAgentChange={setAgentId}
          counts={scopeCounts}
        />
      )}
    </div>
  );
}

export default function LabGuardrailsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading guardrails…</p>
        </div>
      }
    >
      <LabGuardrailsInner />
    </Suspense>
  );
}
