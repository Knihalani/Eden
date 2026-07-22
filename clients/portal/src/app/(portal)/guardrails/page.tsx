"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { agentsApi, guardrailsApi } from "@/lib/api/agents";
import type { GuardrailPolicyRow } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";
import {
  GUARDRAILS_TABS,
  type GuardrailsTab,
} from "@/lib/guardrails-url";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { useGuardrailsUrlState } from "./_hooks/use-guardrails-url-state";
import { GuardrailsHubToolbar } from "./_components/guardrails-hub-toolbar";
import { PoliciesTab } from "./_components/policies-tab";
import { PolicyDetailPanel } from "./_components/policy-detail-panel";
import { PolicyCreateDialog } from "./_components/policy-create-dialog";
import { ViolationsTab } from "./_components/violations-tab";
import { ViolationDetailPanel } from "./_components/violation-detail-panel";
import {
  filterViolations,
  mapScanToViolation,
  policyConfigFromDraft,
  type PolicyDraft,
  type ScanHistoryRow,
  type ViolationRow,
} from "./_components/map-violations";

function GuardrailsPageInner() {
  const t = useTranslations("guardrails");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");

  const { state, setState, clearSelection } = useGuardrailsUrlState();
  const tab = state.tab;
  const q = state.q ?? "";

  const [createOpen, setCreateOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1279px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (isFormField) return;

      if (e.key === "Escape") {
        e.preventDefault();
        clearSelection();
        return;
      }

      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < GUARDRAILS_TABS.length) {
        e.preventDefault();
        setState({
          tab: GUARDRAILS_TABS[idx],
          policyId: undefined,
          violationId: undefined,
        });
        return;
      }

      if (e.key === "n" && canMutate && tab === "policies") {
        e.preventDefault();
        setCreateOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canMutate, clearSelection, setState, tab]);

  const policiesQuery = useOrgQuery(
    queryKeys.guardrails.policies(orgId),
    orgId,
    () => guardrailsApi.listPolicies(orgId!),
  );

  const violationsQuery = useOrgQuery(
    queryKeys.guardrails.violations(orgId, {
      pastHours: state.pastHours,
    }),
    orgId,
    async () => {
      const res = await guardrailsApi.scanHistory(orgId!, { limit: 200 });
      const scans = (res.scans ?? []) as ScanHistoryRow[];
      return scans.map(mapScanToViolation);
    },
    { enabled: tab === "violations" },
  );

  const agentsQuery = useOrgQuery(
    queryKeys.agents.list(orgId),
    orgId,
    () => agentsApi.list(orgId!, { limit: 100 }),
  );

  const createMutation = useOrgMutation(
    (draft: PolicyDraft) =>
      guardrailsApi.createPolicy(orgId!, {
        name: draft.name.trim(),
        kind: draft.kind,
        action: draft.action,
        config: policyConfigFromDraft(draft),
      }),
    {
      invalidateKeys: [queryKeys.guardrails.policies(orgId)],
    },
  );

  const policies: GuardrailPolicyRow[] = policiesQuery.data?.policies ?? [];
  const agents = agentsQuery.data?.agents ?? [];

  const violations: ViolationRow[] = useMemo(() => {
    const rows = violationsQuery.data ?? [];
    return filterViolations(rows, {
      q: state.q,
      agentId: state.agentId,
      severity: state.severity,
      pastHours: state.pastHours ?? "24",
      from: state.from,
      to: state.to,
    });
  }, [
    violationsQuery.data,
    state.q,
    state.agentId,
    state.severity,
    state.pastHours,
    state.from,
    state.to,
  ]);

  const selectedPolicy =
    policies.find((p) => p.policy_id === state.policyId) ?? null;
  const selectedViolation =
    violations.find((v) => v.violationId === state.violationId) ?? null;

  const policyDetailOpen = tab === "policies" && Boolean(state.policyId);
  const violationDetailOpen =
    tab === "violations" && Boolean(state.violationId);

  const desktopPolicyDetail = policyDetailOpen && !isNarrow;
  const sheetPolicyDetail = policyDetailOpen && isNarrow;
  const desktopViolationDetail = violationDetailOpen && !isNarrow;
  const sheetViolationDetail = violationDetailOpen && isNarrow;

  function setTab(next: GuardrailsTab) {
    setState({
      tab: next,
      policyId: undefined,
      violationId: undefined,
    });
  }

  async function persistPolicy(draft: PolicyDraft) {
    const created = await createMutation.mutateAsync(draft);
    setState({ policyId: created.policy_id });
  }

  const headerActions =
    canMutate && tab === "policies" ? (
      <Button
        type="button"
        size="sm"
        className="min-h-11"
        onClick={() => setCreateOpen(true)}
        data-testid="guardrails-new-policy"
      >
        {t("policies.new")}
      </Button>
    ) : undefined;

  return (
    <div
      className="mx-auto max-w-7xl space-y-4 p-4"
      data-testid="guardrails-hub"
    >
      <ResourcePageShell
        header={
          <PageHeader
            title={t("title")}
            subtitle={t("subtitle")}
            actions={headerActions}
          />
        }
        toolbar={
          <div className="space-y-3">
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="guardrails-tabs-chrome"
            >
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as GuardrailsTab)}
              >
                <TabsList variant="underline" aria-label={t("tabsAria")}>
                  {GUARDRAILS_TABS.map((id) => (
                    <TabsTrigger
                      key={id}
                      variant="underline"
                      value={id}
                      className="min-h-11"
                      data-testid={`guardrails-tab-${id}`}
                    >
                      {t(`tabs.${id}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            <GuardrailsHubToolbar
              tab={tab}
              q={q}
              severity={state.severity}
              pastHours={state.pastHours}
              onSearchChange={(value) =>
                setState({ q: value || undefined })
              }
              onSeverityChange={(value) =>
                setState({ severity: value as typeof state.severity })
              }
              onPastHoursChange={(value) =>
                setState({ pastHours: value })
              }
            />

            {role === "viewer" ? (
              <p
                className="text-sm text-[var(--text-muted)]"
                data-testid="guardrails-viewer-readonly"
              >
                {t("viewerReadonly")}
              </p>
            ) : null}
          </div>
        }
        table={
          <div data-testid={`guardrails-panel-${tab}`}>
            {tab === "policies" ? (
              <PoliciesTab
                policies={policies}
                loading={policiesQuery.isLoading}
                error={policiesQuery.error}
                onRetry={() => void policiesQuery.refetch()}
                q={state.q}
                severity={state.severity}
                agentId={state.agentId}
                selectedId={state.policyId}
                canMutate={canMutate}
                onSelect={(policyId) => setState({ policyId })}
                onNewPolicy={() => setCreateOpen(true)}
                onClearFilters={() =>
                  setState({
                    q: undefined,
                    severity: undefined,
                    agentId: undefined,
                  })
                }
              />
            ) : (
              <ViolationsTab
                violations={violations}
                loading={violationsQuery.isLoading}
                error={violationsQuery.error}
                onRetry={() => void violationsQuery.refetch()}
                filtersActive={Boolean(
                  state.q?.trim() ||
                    state.severity ||
                    state.agentId ||
                    state.pastHours,
                )}
                selectedId={state.violationId}
                onSelect={(violationId) => setState({ violationId })}
                onClearFilters={() =>
                  setState({
                    q: undefined,
                    severity: undefined,
                    agentId: undefined,
                    pastHours: undefined,
                    from: undefined,
                    to: undefined,
                  })
                }
                onOpenPolicies={() => setTab("policies")}
              />
            )}
          </div>
        }
        detail={
          desktopPolicyDetail ? (
            <PolicyDetailPanel
              open
              policy={selectedPolicy}
              agents={agents}
              canMutate={canMutate}
              pending={createMutation.isPending}
              mobileDrawer={false}
              onClose={clearSelection}
              onSave={persistPolicy}
              onViewViolations={(policyId) =>
                setState({
                  tab: "violations",
                  policyId: undefined,
                  violationId: undefined,
                  q: policyId,
                })
              }
            />
          ) : desktopViolationDetail ? (
            <ViolationDetailPanel
              open
              violation={selectedViolation}
              mobileDrawer={false}
              onClose={clearSelection}
            />
          ) : undefined
        }
      />

      {sheetPolicyDetail ? (
        <PolicyDetailPanel
          open
          policy={selectedPolicy}
          agents={agents}
          canMutate={canMutate}
          pending={createMutation.isPending}
          mobileDrawer
          onClose={clearSelection}
          onSave={persistPolicy}
          onViewViolations={(policyId) =>
            setState({
              tab: "violations",
              policyId: undefined,
              violationId: undefined,
              q: policyId,
            })
          }
        />
      ) : null}

      {sheetViolationDetail ? (
        <ViolationDetailPanel
          open
          violation={selectedViolation}
          mobileDrawer
          onClose={clearSelection}
        />
      ) : null}

      <PolicyCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={createMutation.isPending}
        onSubmit={persistPolicy}
      />

      <nav
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-3 text-sm"
        aria-label={t("related.aria")}
        data-testid="guardrails-related-strip"
      >
        <span className="text-[var(--text-muted)]">{t("related.label")}</span>
        <Link
          href="/alerts?tab=rules"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.alerts")}
        </Link>
        <Link href="/traces" className="text-[var(--accent)] hover:underline">
          {t("related.traces")}
        </Link>
        <Link
          href="/improve?tab=queue"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.improve")}
        </Link>
        <Link
          href="/settings?tab=gateway"
          className="text-[var(--accent)] hover:underline"
        >
          {t("related.settings")}
        </Link>
      </nav>
    </div>
  );
}

export default function GuardrailsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <GuardrailsPageInner />
    </Suspense>
  );
}
