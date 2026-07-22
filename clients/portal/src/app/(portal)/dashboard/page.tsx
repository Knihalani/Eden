"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
import { useAgentOsData } from "@/app/(portal)/_hooks/use-agent-os-data";
import { PageHeader } from "@/components/ui/page-header";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { DiagnosisStrip } from "./_components/diagnosis-strip";
import { AgentOsList } from "./_components/agent-os-list";
import { NextActionPanel } from "./_components/next-action-panel";
import { DashboardToolbar } from "./_components/dashboard-toolbar";
import { DashboardSkeleton } from "./_components/dashboard-skeleton";

function DashboardInner() {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [live, setLive] = useState(false);

  const data = useAgentOsData({ live });

  const agentOptions = useMemo(
    () =>
      data.rawAgents.map((a) => ({
        id: a.agent_id,
        name: a.name || a.agent_id,
      })),
    [data.rawAgents],
  );

  const filtersActive = Boolean(
    data.agentIdFilter || data.pastHours !== 24,
  );

  const isHealthy =
    !data.isFirstRun &&
    data.diagnosis.openIssueCount === 0 &&
    data.diagnosis.errorTraceCount === 0;

  function clearFilters() {
    router.replace("/dashboard");
  }

  const loading = data.agentsLoading && data.rawAgents.length === 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="dashboard-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        {!data.isFirstRun ? (
          <DashboardToolbar
            pastHours={data.pastHours}
            live={live}
            onLiveChange={setLive}
            agentOptions={agentOptions}
          />
        ) : null}
      </div>

      <QueryState
        loading={loading}
        error={data.agentsError}
        data={data}
        onRetry={data.refetchAll}
        isEmpty={() =>
          data.isFirstRun ||
          (filtersActive && data.agents.length === 0)
        }
        filtersActive={filtersActive && !data.isFirstRun}
        emptyKind={
          filtersActive && !data.isFirstRun ? "filter-empty" : "zero-data"
        }
        loadingSlot={<DashboardSkeleton />}
        emptySlot={
          <div className="space-y-4">
            <DiagnosisStrip
              diagnosis={data.diagnosis}
              loading={false}
              isHealthy={false}
            />
            <EmptyState
              icon={Bot}
              variant="panel"
              size="md"
              title={t("empty.title")}
              description={t("empty.body")}
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/agents/connect">{t("empty.connect")}</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={DOCS_QUICKSTART_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("empty.docs")}
                    </a>
                  </Button>
                </div>
              }
            />
            <NextActionPanel nextAction={data.nextAction} failures={[]} />
          </div>
        }
        filterEmptySlot={
          <EmptyState
            variant="panel"
            title={t("filterEmpty.title")}
            description={t("filterEmpty.body")}
            action={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={clearFilters}
              >
                {t("filterEmpty.clear")}
              </Button>
            }
          />
        }
      >
        {() => (
          <div className="space-y-4">
            <DiagnosisStrip
              diagnosis={data.diagnosis}
              loading={data.diagnosisLoading}
              error={data.diagnosisError}
              onRetry={data.refetchAll}
              isHealthy={isHealthy}
              live={live}
            />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <AgentOsList
                agents={data.agents}
                highlightAgentId={data.agentIdFilter}
              />
              <NextActionPanel
                nextAction={data.nextAction}
                failures={data.failures}
              />
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardInner />
    </Suspense>
  );
}
