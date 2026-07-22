"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
import { useAgentOsData } from "@/app/(portal)/_hooks/use-agent-os-data";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { usePermissions } from "@/hooks/use-permissions";
import { PageHeader } from "@/components/ui/page-header";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentHealthStatus } from "@/lib/agent-health";
import { AgentsListTable } from "./_components/agents-list-table";
import { FleetHealthTable } from "./_components/fleet-health-table";

function AgentsPageInner() {
  const t = useTranslations("agents");
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "fleet" ? "fleet" : "list";
  const q = searchParams.get("q") ?? "";
  const statusFilter = searchParams.get("status") as AgentHealthStatus | null;

  const { hasPermission, role } = usePermissions();
  const canConnect =
    hasPermission("jobs:write") ||
    (role != null && role !== "viewer");

  const data = useAgentOsData({ includeFleet: tab === "fleet" });
  const [focusedIndex, setFocusedIndex] = useState(0);

  const filtered = useMemo(() => {
    let rows = data.agents;
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.displayName.toLowerCase().includes(needle) ||
          r.agentId.toLowerCase().includes(needle),
      );
    }
    if (statusFilter) {
      rows = rows.filter((r) => r.status === statusFilter);
    }
    return rows;
  }, [data.agents, q, statusFilter]);

  const filtersActive = Boolean(q.trim() || statusFilter);

  useListKeyboardNav(
    filtered.length,
    focusedIndex,
    (idx) => {
      setFocusedIndex(idx);
      const row = filtered[idx];
      if (row) router.push(`/agents/${encodeURIComponent(row.agentId)}`);
    },
    tab === "list" && filtered.length > 0,
  );

  function setTab(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "list") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `/agents?${qs}` : "/agents");
  }

  function setSearch(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("q", value);
    else params.delete("q");
    const qs = params.toString();
    router.replace(qs ? `/agents?${qs}` : "/agents");
  }

  function setStatus(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("status", value);
    else params.delete("status");
    const qs = params.toString();
    router.replace(qs ? `/agents?${qs}` : "/agents");
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    params.delete("status");
    const qs = params.toString();
    router.replace(qs ? `/agents?${qs}` : "/agents");
  }

  const connectCta = canConnect ? (
    <Button asChild size="sm" className="min-h-11">
      <Link href="/agents/connect">{t("connectCta")}</Link>
    </Button>
  ) : (
    <Button size="sm" disabled className="min-h-11" title={t("connectViewerHint")}>
      {t("connectCta")}
    </Button>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="agents-page">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={connectCta}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList variant="underline">
            <TabsTrigger variant="underline" value="list">
              {t("tabs.list")}
            </TabsTrigger>
            <TabsTrigger variant="underline" value="fleet">
              {t("tabs.fleet")}
            </TabsTrigger>
          </TabsList>

          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="agents-toolbar"
          >
            <Input
              value={q}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-11 min-w-[10rem] max-w-xs"
              aria-label={t("searchPlaceholder")}
            />
            <select
              className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
              value={statusFilter ?? ""}
              onChange={(e) => setStatus(e.target.value)}
              aria-label={t("statusFilter")}
            >
              <option value="">{t("statusAll")}</option>
              <option value="healthy">{t("status.healthy")}</option>
              <option value="degraded">{t("status.degraded")}</option>
              <option value="failing">{t("status.failing")}</option>
              <option value="idle">{t("status.idle")}</option>
              <option value="silent">{t("status.silent")}</option>
              <option value="unknown">{t("status.unknown")}</option>
            </select>
          </div>
        </div>

        <TabsContent value="list" className="mt-4">
          <QueryState
            loading={data.agentsLoading}
            error={data.agentsError}
            data={filtered}
            onRetry={data.refetchAll}
            isEmpty={(rows) => rows.length === 0}
            filtersActive={filtersActive}
            emptyKind={filtersActive ? "filter-empty" : "zero-data"}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={Bot}
                variant="panel"
                title={t("empty.title")}
                description={t("empty.body")}
                action={
                  canConnect ? (
                    <Button asChild size="sm">
                      <Link href="/agents/connect">{t("connectCta")}</Link>
                    </Button>
                  ) : (
                    <p className="text-sm text-[var(--text-muted)]">
                      {t("connectViewerHint")}
                    </p>
                  )
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                variant="panel"
                title={t("filterEmpty.title")}
                description={t("filterEmpty.body")}
                action={
                  <Button type="button" size="sm" variant="secondary" onClick={clearFilters}>
                    {t("filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(rows) => (
              <AgentsListTable
                rows={rows}
                focusedIndex={focusedIndex}
                onFocusIndex={setFocusedIndex}
              />
            )}
          </QueryState>
        </TabsContent>

        <TabsContent value="fleet" className="mt-4">
          <QueryState
            loading={data.fleetLoading}
            error={data.fleetError}
            data={data.fleetAgents}
            onRetry={data.refetchAll}
            isEmpty={(rows) => rows.length === 0}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={Bot}
                variant="panel"
                title={t("fleet.emptyTitle")}
                description={t("fleet.emptyBody")}
                action={
                  canConnect ? (
                    <Button asChild size="sm">
                      <Link href="/agents/connect">{t("connectCta")}</Link>
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {(fleet) => <FleetHealthTable agents={fleet} />}
          </QueryState>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-6xl space-y-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <AgentsPageInner />
    </Suspense>
  );
}
