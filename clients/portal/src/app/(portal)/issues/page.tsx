"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, ApiError, type AgentIssue } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookOpen, ChevronDown, Loader2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import {
  CoreResourcePage,
  useResourceUrlState,
  ResourceOsToolbar,
  BulkActionBar,
} from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryTab } from "@/hooks/use-query-tab";
import { usePagePerf } from "@/lib/perf";
import { useToast } from "@/components/ui/toast";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useQueryClient } from "@tanstack/react-query";
import { DOCS_URL } from "@/lib/constants";
import { ISSUE_STATUS_VIEW_PRESETS, ISSUE_STATUS_FILTERS } from "./_components/issue-status-views";
import { IssuesList, PAGE_SIZE } from "./_components/issues-list";
import { IssuesDetailPanel } from "./_components/issues-detail-panel";

const TOP_TABS = ["issues", "incidents"] as const;
const TOP_TAB_LABELS: Record<(typeof TOP_TABS)[number], string> = {
  issues: "Agent Issues",
  incidents: "Incidents",
};

const IncidentsView = dynamic(() => import("@/app/(portal)/incidents/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  ),
});

function IssuesPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  usePagePerf("/issues");
  const [tab, setTab] = useQueryTab("tab", TOP_TABS, "issues");
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const issueId = urlState.issueId;
  const [listIssues, setListIssues] = useState<AgentIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const toast = useToast();
  const queryClient = useQueryClient();

  const issueDetailQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId!),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const selectedIssue: AgentIssue | null = issueDetailQuery.data?.data?.issue ?? null;
  const issueDetailNotFound =
    issueDetailQuery.error instanceof ApiError && issueDetailQuery.error.status === 404;
  const issueDetailError = issueDetailQuery.error?.message ?? null;
  const issueIndex = issueId ? listIssues.findIndex((i) => i.id === issueId) : -1;

  useListKeyboardNav(
    listIssues.length,
    issueIndex >= 0 ? issueIndex : 0,
    (idx) => {
      const row = listIssues[idx];
      if (row) setUrlState({ issueId: row.id });
    },
    tab === "issues" && listIssues.length > 0,
  );

  const exportRows = listIssues.map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    stumbles: i.stumble_count,
  }));

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Issues"
        icon={ShieldAlert}
        description="Select an organization to review grouped agent failures"
      />
    );
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof TOP_TABS)[number])}>
      <CoreResourcePage
        header={
          <PageHeader
            title="Agent Issues"
            subtitle={
              tab === "incidents"
                ? "Incidents nest here — systemic RCA clusters across many traces (not a separate sidebar leaf)."
                : "Grouped agent failures — the primary triage loop. Switch to Incidents for systemic RCA clusters."
            }
            description="Triage stumbles here; Incidents cluster many failures into one RCA summary. /incidents redirects into this hub."
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="default"
                    className="min-h-11"
                    aria-label="More links"
                  >
                    More
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  <DropdownMenuLabel>Related</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href="/signals" data-testid="issues-more-signals">
                      Signals
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
                      <BookOpen className="mr-2 h-3 w-3" /> Docs
                    </a>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        }
        toolbar={
          <div className="flex flex-col gap-space-3" data-testid="issues-toolbar">
            <TabsList
              variant="underline"
              aria-label="Issues sections"
              className="h-auto w-full justify-start gap-space-1 bg-transparent"
            >
              {TOP_TABS.map((t) => (
                <TabsTrigger
                  key={t}
                  variant="underline"
                  value={t}
                  title={TOP_TAB_LABELS[t]}
                  className="min-h-11"
                >
                  {TOP_TAB_LABELS[t]}
                </TabsTrigger>
              ))}
            </TabsList>
            {tab === "issues" ? (
              <ResourceOsToolbar
                resourceKey="issues"
                sticky
                viewPresets={ISSUE_STATUS_VIEW_PRESETS}
                onCreateAlert={() => {
                  router.push("/alerts?tab=rules");
                }}
                exportRows={exportRows}
                exportFilename="issues.csv"
                selects={[
                  {
                    key: "status",
                    label: "Status",
                    value: statusFilter === "all" ? "" : statusFilter,
                    options: ISSUE_STATUS_FILTERS.filter((s) => s !== "all").map((s) => ({
                      value: s,
                      label: s.replace("_", " "),
                    })),
                  },
                ]}
                onFiltersChange={(next) => {
                  const status = next.status?.trim();
                  setStatusFilter(status ? status : "all");
                  setLimit(PAGE_SIZE);
                }}
              />
            ) : null}
          </div>
        }
        table={
          <>
            <TabsContent value="issues" className="mt-0">
              <IssuesList
                selectedId={issueId}
                onSelect={(id) => setUrlState({ issueId: id })}
                onIssuesChange={setListIssues}
                selectedIds={selectedIds}
                onSelectedIdsChange={setSelectedIds}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                limit={limit}
                onLimitChange={setLimit}
              />
            </TabsContent>
            <TabsContent value="incidents" className="mt-0">
              <EmbeddedSurface>
                <IncidentsView />
              </EmbeddedSurface>
            </TabsContent>
          </>
        }
        bulkBar={
          <BulkActionBar
            count={selectedIds.length}
            hideOnMobile
            onClear={() => setSelectedIds([])}
            actions={[
              {
                label: bulkBusy ? "Triaging…" : "Mark triaged",
                onClick: () => {
                  if (!orgId || selectedIds.length === 0 || bulkBusy) return;
                  setBulkBusy(true);
                  void Promise.allSettled(
                    selectedIds.map((id) =>
                      agentIssuesApi.triage(orgId, id, { force: false }),
                    ),
                  )
                    .then((results) => {
                      const ok = results.filter((r) => r.status === "fulfilled").length;
                      toast.success(`Triaged ${ok}/${selectedIds.length} issues`);
                      setSelectedIds([]);
                      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.all });
                    })
                    .finally(() => setBulkBusy(false));
                },
              },
              {
                label: bulkBusy ? "Resolving…" : "Resolve",
                variant: "destructive",
                onClick: () => {
                  if (!orgId || selectedIds.length === 0 || bulkBusy) return;
                  setBulkBusy(true);
                  void Promise.allSettled(
                    selectedIds.map((id) =>
                      agentIssuesApi.resolve(orgId, id, { status: "resolved" }),
                    ),
                  )
                    .then((results) => {
                      const ok = results.filter((r) => r.status === "fulfilled").length;
                      toast.success(`Resolved ${ok}/${selectedIds.length} issues`);
                      setSelectedIds([]);
                      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.all });
                    })
                    .finally(() => setBulkBusy(false));
                },
              },
            ]}
          />
        }
        detail={
          issueId ? (
            <IssuesDetailPanel
              issueId={issueId}
              selectedIssue={selectedIssue}
              loading={issueDetailQuery.isLoading}
              notFound={issueDetailNotFound || (!selectedIssue && !issueDetailError)}
              error={issueDetailError}
              onClose={() => setUrlState({ issueId: undefined })}
              onPrev={
                issueIndex > 0
                  ? () => setUrlState({ issueId: listIssues[issueIndex - 1]?.id })
                  : undefined
              }
              onNext={
                issueIndex >= 0 && issueIndex < listIssues.length - 1
                  ? () => setUrlState({ issueId: listIssues[issueIndex + 1]?.id })
                  : undefined
              }
              onRetry={() => void issueDetailQuery.refetch()}
              primaryBusy={bulkBusy}
              onPrimaryAction={() => {
                if (!orgId || !selectedIssue) return;
                setBulkBusy(true);
                void agentIssuesApi
                  .triage(orgId, selectedIssue.id)
                  .then(() => {
                    toast.success("Triage started");
                    void issueDetailQuery.refetch();
                  })
                  .catch((e: unknown) =>
                    toast.error(e instanceof Error ? e.message : "Triage failed"),
                  )
                  .finally(() => setBulkBusy(false));
              }}
            />
          ) : null
        }
      />
    </Tabs>
  );
}

export default function IssuesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <IssuesPageInner />
    </Suspense>
  );
}
