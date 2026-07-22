"use client";

import { Suspense, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { agentsApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import { useAgentOsData } from "@/app/(portal)/_hooks/use-agent-os-data";
import { PageHeader } from "@/components/ui/page-header";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { AgentHealthStrip } from "../_components/agent-health-strip";

const DETAIL_TABS = [
  "overview",
  "traces",
  "issues",
  "ledger",
  "artifacts",
  "book",
  "drift",
  "cost",
  "guardrails",
] as const;

type DetailTab = (typeof DETAIL_TABS)[number];

function isDetailTab(v: string | null): v is DetailTab {
  return DETAIL_TABS.includes(v as DetailTab);
}

function PeekPanel({
  title,
  href,
  viewAll,
  children,
}: {
  title: string;
  href: string;
  viewAll: string;
  children: ReactNode;
}) {
  return (
    <Panel tone="flat" padding="md" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--text-primary)] m-0">
          {title}
        </h3>
        <Link
          href={href}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          {viewAll}
        </Link>
      </div>
      <div className="text-sm text-[var(--text-secondary)]">{children}</div>
    </Panel>
  );
}

function AgentDetailInner() {
  const t = useTranslations("agents");
  const tDetail = useTranslations("agents.detail");
  const params = useParams<{ id: string }>();
  const agentId = decodeURIComponent(params.id);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: DetailTab = isDetailTab(tabParam) ? tabParam : "overview";

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const agentQuery = useOrgQuery(
    queryKeys.agents.detail(orgId, agentId),
    orgId,
    () => agentsApi.get(orgId!, agentId),
  );

  const os = useAgentOsData({ agentId, includeFleet: false });

  const row = useMemo(
    () => os.agents.find((a) => a.agentId === agentId) ?? null,
    [os.agents, agentId],
  );

  const displayName =
    agentQuery.data?.name || row?.displayName || agentId;
  const status = row?.status ?? "unknown";
  const solidCta =
    status === "failing" || status === "degraded"
      ? {
          href: `/improve?tab=plans&agentId=${encodeURIComponent(agentId)}`,
          label: tDetail("ctaCreatePlan"),
        }
      : {
          href: `/traces?agentId=${encodeURIComponent(agentId)}`,
          label: tDetail("ctaOpenTraces"),
        };

  function setTab(next: string) {
    const paramsNext = new URLSearchParams(searchParams.toString());
    if (next === "overview") paramsNext.delete("tab");
    else paramsNext.set("tab", next);
    const qs = paramsNext.toString();
    router.replace(
      qs
        ? `/agents/${encodeURIComponent(agentId)}?${qs}`
        : `/agents/${encodeURIComponent(agentId)}`,
    );
  }

  const recentFailures = os.failures.filter(
    (f) => !f.agentId || f.agentId === agentId,
  );
  const agentIssues = os.openIssues.filter((i) => i.agent_id === agentId);

  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="agent-detail">
      <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-muted)]">
        <Link href="/agents" className="hover:text-[var(--text-primary)]">
          {t("title")}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-[var(--text-secondary)]">{displayName}</span>
      </nav>

      <PageHeader
        title={displayName}
        subtitle={tDetail("subtitle")}
        actions={
          <Button asChild size="sm" className="min-h-11">
            <Link href={solidCta.href}>{solidCta.label}</Link>
          </Button>
        }
      />

      <QueryState
        loading={agentQuery.isLoading}
        error={agentQuery.error}
        data={agentQuery.data ?? { agent_id: agentId, name: displayName }}
        onRetry={() => {
          void agentQuery.refetch();
          os.refetchAll();
        }}
        loadingSlot={<Skeleton className="h-24 w-full" />}
      >
        {() => (
          <>
            <AgentHealthStrip
              status={status}
              agentId={agentId}
              lastSeenAt={row?.lastSeenAt ?? agentQuery.data?.last_seen_at ?? null}
              errorRate={row?.errorRate ?? null}
              openIssueCount={row?.openIssueCount ?? agentIssues.length}
            />

            <Tabs value={tab} onValueChange={setTab} className="mt-4">
              <TabsList variant="underline" className="flex-wrap">
                {DETAIL_TABS.map((id) => (
                  <TabsTrigger key={id} variant="underline" value={id}>
                    {tDetail(`tabs.${id}`)}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="overview" className="mt-4 space-y-3">
                {os.tracesTotal === 0 ? (
                  <EmptyState
                    variant="panel"
                    title={tDetail("noTraffic.title")}
                    description={tDetail("noTraffic.body")}
                    action={
                      <div className="flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="secondary">
                          <Link href="/agents/connect">
                            {t("connectCta")}
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="ghost">
                          <a
                            href={DOCS_QUICKSTART_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {tDetail("noTraffic.docs")}
                          </a>
                        </Button>
                      </div>
                    }
                  />
                ) : (
                  <div className="grid gap-3 lg:grid-cols-2">
                    <PeekPanel
                      title={tDetail("peeks.traces")}
                      href={`/traces?agentId=${encodeURIComponent(agentId)}`}
                      viewAll={tDetail("viewAll")}
                    >
                      {recentFailures.length === 0
                        ? tDetail("peeks.tracesEmpty")
                        : recentFailures.slice(0, 3).map((f) => (
                            <div key={f.traceId} className="font-mono text-xs">
                              <Link
                                href={`/traces?traceId=${encodeURIComponent(f.traceId)}`}
                                className="text-[var(--accent)] hover:underline"
                              >
                                {f.traceId}
                              </Link>{" "}
                              · {f.summary}
                            </div>
                          ))}
                    </PeekPanel>
                    <PeekPanel
                      title={tDetail("peeks.issues")}
                      href={`/issues?agentId=${encodeURIComponent(agentId)}`}
                      viewAll={tDetail("viewAll")}
                    >
                      {agentIssues.length === 0
                        ? tDetail("peeks.issuesEmpty")
                        : agentIssues.slice(0, 3).map((i) => (
                            <div key={i.id}>
                              <Link
                                href={`/issues?issueId=${encodeURIComponent(i.id)}`}
                                className="hover:underline"
                              >
                                {i.title}
                              </Link>
                            </div>
                          ))}
                    </PeekPanel>
                    <PeekPanel
                      title={tDetail("peeks.ledger")}
                      href={`/agents/${encodeURIComponent(agentId)}/ledger`}
                      viewAll={tDetail("viewAll")}
                    >
                      {tDetail("peeks.ledgerHint")}
                    </PeekPanel>
                    <PeekPanel
                      title={tDetail("peeks.improve")}
                      href={`/improve?tab=artifacts&agentId=${encodeURIComponent(agentId)}`}
                      viewAll={tDetail("viewAll")}
                    >
                      {tDetail("peeks.improveHint")}
                    </PeekPanel>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="traces" className="mt-4">
                <PeekPanel
                  title={tDetail("peeks.traces")}
                  href={`/traces?agentId=${encodeURIComponent(agentId)}`}
                  viewAll={tDetail("viewAll")}
                >
                  {tDetail("peeks.tracesTabBody")}
                </PeekPanel>
              </TabsContent>

              <TabsContent value="issues" className="mt-4">
                <PeekPanel
                  title={tDetail("peeks.issues")}
                  href={`/issues?agentId=${encodeURIComponent(agentId)}`}
                  viewAll={tDetail("viewAll")}
                >
                  {agentIssues.length === 0
                    ? tDetail("peeks.issuesEmpty")
                    : tDetail("peeks.issuesCount", {
                        count: agentIssues.length,
                      })}
                </PeekPanel>
              </TabsContent>

              <TabsContent value="ledger" className="mt-4">
                <PeekPanel
                  title={tDetail("peeks.ledger")}
                  href={`/agents/${encodeURIComponent(agentId)}/ledger`}
                  viewAll={tDetail("openLedger")}
                >
                  {tDetail("peeks.ledgerHint")}
                </PeekPanel>
              </TabsContent>

              <TabsContent value="artifacts" className="mt-4">
                <PeekPanel
                  title={tDetail("tabs.artifacts")}
                  href={`/improve?tab=artifacts&agentId=${encodeURIComponent(agentId)}`}
                  viewAll={tDetail("viewAll")}
                >
                  {tDetail("peeks.artifactsHint")}
                </PeekPanel>
              </TabsContent>

              <TabsContent value="book" className="mt-4">
                <Panel tone="flat" padding="md">
                  <p className="text-sm text-[var(--text-secondary)] m-0">
                    {tDetail("peeks.bookHint")}
                  </p>
                </Panel>
              </TabsContent>

              <TabsContent value="drift" className="mt-4">
                <Panel tone="flat" padding="md">
                  <p className="text-sm text-[var(--text-secondary)] m-0">
                    {tDetail("peeks.driftHint")}
                  </p>
                </Panel>
              </TabsContent>

              <TabsContent value="cost" className="mt-4">
                <PeekPanel
                  title={tDetail("tabs.cost")}
                  href={`/cost?agentId=${encodeURIComponent(agentId)}`}
                  viewAll={tDetail("viewAll")}
                >
                  {tDetail("peeks.costHint")}
                </PeekPanel>
              </TabsContent>

              <TabsContent value="guardrails" className="mt-4">
                <PeekPanel
                  title={tDetail("tabs.guardrails")}
                  href={`/guardrails?agentId=${encodeURIComponent(agentId)}`}
                  viewAll={tDetail("viewAll")}
                >
                  {tDetail("peeks.guardrailsHint")}
                </PeekPanel>
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryState>
    </div>
  );
}

export default function AgentDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
        </div>
      }
    >
      <AgentDetailInner />
    </Suspense>
  );
}
