"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { agentIssuesApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useObserveUrlState } from "@/app/(portal)/_hooks/use-observe-url-state";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IssuesToolbar } from "./_components/issues-toolbar";
import { IssuesTable } from "./_components/issues-table";
import { IssueDetailPanel } from "./_components/issue-detail-panel";
import { IssueDetailSheet } from "./_components/issue-detail-sheet";
import {
  isIncidentCluster,
  isOpenIssueStatus,
  mapIssue,
  mapStumbleToFinding,
  parseIssuesTab,
  type FindingRow,
  type IssueRow,
  type IssuesTab,
} from "./_components/issue-map";

function useIsXl() {
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setIsXl(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isXl;
}

function withinPastHours(iso: string | null, pastHours: number): boolean {
  if (!iso) return true;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return true;
  return Date.now() - ms <= pastHours * 3_600_000;
}

function IssuesPageInner() {
  const t = useTranslations("issues");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { hasPermission, role } = usePermissions();
  const canMutate =
    hasPermission("jobs:write") || (role != null && role !== "viewer");
  const { state, setState, clearSelection, searchParams } =
    useObserveUrlState();
  const isXl = useIsXl();

  const tab = parseIssuesTab(state.tab);
  const q = state.q ?? "";
  const severity = state.filter ?? "";
  const agentId = state.agentId;
  const pastHours = state.pastHours ?? "24";
  const pastHoursNum = Number(pastHours) || 24;
  const issueId = state.issueId;

  const listQuery = useOrgQuery(
    queryKeys.issues.list(orgId, { limit: 100 }),
    orgId,
    () => agentIssuesApi.list(orgId!, { limit: 100 }),
  );

  const allRows: IssueRow[] = useMemo(
    () => (listQuery.data?.data?.issues ?? []).map(mapIssue),
    [listQuery.data],
  );

  const filtered = useMemo(() => {
    let rows = allRows;
    if (tab === "open") {
      rows = rows.filter((r) => isOpenIssueStatus(r.status));
    } else if (tab === "incidents") {
      rows = rows.filter(isIncidentCluster);
    }
    if (severity) {
      rows = rows.filter((r) => r.severity === severity);
    }
    if (agentId) {
      rows = rows.filter((r) => r.agentId === agentId);
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          r.issueId.toLowerCase().includes(needle) ||
          r.fingerprint.toLowerCase().includes(needle),
      );
    }
    rows = rows.filter((r) => withinPastHours(r.lastSeenAt, pastHoursNum));
    return rows;
  }, [allRows, tab, severity, agentId, q, pastHoursNum]);

  const filtersActive = Boolean(
    q.trim() ||
      severity ||
      agentId ||
      tab !== "all" ||
      pastHours !== "24",
  );

  const selectedIndex = issueId
    ? filtered.findIndex((r) => r.issueId === issueId)
    : -1;
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    if (selectedIndex >= 0) setFocusedIndex(selectedIndex);
  }, [selectedIndex]);

  useListKeyboardNav(
    filtered.length,
    focusedIndex,
    (idx) => {
      setFocusedIndex(idx);
      const row = filtered[idx];
      if (row) setState({ issueId: row.issueId });
    },
    filtered.length > 0,
  );

  const listRow = issueId
    ? (filtered.find((r) => r.issueId === issueId) ??
      allRows.find((r) => r.issueId === issueId))
    : undefined;

  const detailQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId!),
    { enabled: Boolean(issueId) },
  );

  const detailIssue: IssueRow | null = detailQuery.data?.data?.issue
    ? mapIssue(detailQuery.data.data.issue)
    : (listRow ?? null);

  const fingerprint = detailIssue?.fingerprint;

  const stumblesQuery = useOrgQuery(
    queryKeys.issues.stumbles(orgId, { fingerprint }),
    orgId,
    () =>
      agentIssuesApi.stumbles(orgId!, {
        fingerprint: fingerprint!,
        limit: 50,
      }),
    { enabled: Boolean(fingerprint) },
  );

  const findings: FindingRow[] = useMemo(
    () => (stumblesQuery.data?.data?.stumbles ?? []).map(mapStumbleToFinding),
    [stumblesQuery.data],
  );

  const resolveMutation = useOrgMutation(
    () =>
      agentIssuesApi.resolve(orgId!, issueId!, { status: "resolved" }),
    {
      invalidateKeys: [
        queryKeys.issues.list(orgId, { limit: 100 }),
        queryKeys.issues.detail(orgId, issueId),
      ],
    },
  );

  const triageMutation = useOrgMutation(
    () => agentIssuesApi.triage(orgId!, issueId!, { force: false }),
    {
      invalidateKeys: [
        queryKeys.issues.list(orgId, { limit: 100 }),
        queryKeys.issues.detail(orgId, issueId),
      ],
    },
  );

  function selectIssue(id: string) {
    setState({ issueId: id });
  }

  function closeDetail() {
    clearSelection("issue");
  }

  function setTab(next: IssuesTab) {
    setState({
      tab: next === "open" ? undefined : next,
      issueId: undefined,
    });
  }

  function setSearch(value: string) {
    setState({ q: value || undefined });
  }

  function setSeverity(value: string) {
    setState({ filter: value || undefined });
  }

  function setPastHours(value: string) {
    setState({ pastHours: value === "24" ? undefined : value });
  }

  function clearFilters() {
    setState({
      q: undefined,
      filter: undefined,
      agentId: undefined,
      pastHours: undefined,
      tab: undefined,
      issueId: undefined,
    });
  }

  function goPrev() {
    if (selectedIndex <= 0) return;
    const row = filtered[selectedIndex - 1];
    if (row) selectIssue(row.issueId);
  }

  function goNext() {
    if (selectedIndex < 0 || selectedIndex >= filtered.length - 1) return;
    const row = filtered[selectedIndex + 1];
    if (row) selectIssue(row.issueId);
  }

  const detailOpen = Boolean(issueId);
  const detailBodyProps = {
    issue: detailIssue,
    findings,
    loading:
      (detailQuery.isLoading && !detailIssue) ||
      (stumblesQuery.isLoading && findings.length === 0 && Boolean(fingerprint)),
    error: detailQuery.error,
    onRetry: () => {
      void detailQuery.refetch();
      void stumblesQuery.refetch();
    },
    searchParams,
    canMutate,
    onResolve: canMutate
      ? () => {
          void resolveMutation.mutateAsync();
        }
      : undefined,
    onTriage: canMutate
      ? () => {
          void triageMutation.mutateAsync();
        }
      : undefined,
    mutating: resolveMutation.isPending || triageMutation.isPending,
  };

  const listLoadingSlot = (
    <div className="space-y-2" data-testid="issues-loading">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl" data-testid="issues-page">
      <ResourcePageShell
        header={
          <PageHeader
            title={t("title")}
            subtitle={
              tab === "incidents" ? t("subtitleIncidents") : t("subtitle")
            }
          />
        }
        toolbar={
          <IssuesToolbar
            tab={tab}
            q={q}
            severity={severity}
            agentId={agentId}
            pastHours={pastHours}
            onTabChange={setTab}
            onSearchChange={setSearch}
            onSeverityChange={setSeverity}
            onPastHoursChange={setPastHours}
          />
        }
        table={
          <QueryState
            loading={listQuery.isLoading}
            error={listQuery.error}
            data={filtered}
            onRetry={() => void listQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            filtersActive={filtersActive}
            loadingSlot={listLoadingSlot}
            emptySlot={
              <EmptyState
                icon={AlertTriangle}
                title={t("empty.title")}
                description={t("empty.body")}
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/traces">{t("empty.cta")}</Link>
                  </Button>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                icon={AlertTriangle}
                title={t("filterEmpty.title")}
                description={t("filterEmpty.body")}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="min-h-11"
                      onClick={clearFilters}
                    >
                      {t("filterEmpty.clear")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-11"
                      onClick={() => setTab("all")}
                    >
                      {t("filterEmpty.viewAll")}
                    </Button>
                  </div>
                }
              />
            }
          >
            {(rows) => (
              <IssuesTable
                rows={rows}
                selectedId={issueId}
                focusedIndex={focusedIndex}
                tab={tab}
                onSelect={selectIssue}
                onFocusIndex={setFocusedIndex}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl ? (
            <IssueDetailPanel
              open
              onClose={closeDetail}
              onPrev={selectedIndex > 0 ? goPrev : undefined}
              onNext={
                selectedIndex >= 0 && selectedIndex < filtered.length - 1
                  ? goNext
                  : undefined
              }
              {...detailBodyProps}
            />
          ) : undefined
        }
      />

      <IssueDetailSheet
        open={detailOpen && !isXl}
        onClose={closeDetail}
        {...detailBodyProps}
      />
    </div>
  );
}

export default function IssuesPage() {
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
      <IssuesPageInner />
    </Suspense>
  );
}
