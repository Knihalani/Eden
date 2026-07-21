"use client";

/**
 * /traces — U01 Traces Hub: Traces | Spans | Sessions with split-pane detail.
 * Wave 3 shell ≤400 LOC — state in use-traces-hub, list in traces-hub-list.
 */

import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import {
  ResourcePageShell,
  DetailPanelShell,
} from "@/components/portal-os";
import { TraceSplitLayout } from "@/components/traces/TraceSplitLayout";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { TracesToolbar } from "./_components/TracesToolbar";
import { TracesHubList } from "./_components/traces-hub-list";
import { useTracesHub } from "./_components/use-traces-hub";
import {
  AnnotateTraceDialog,
  DebugView,
  DecisionsFacetView,
  InspectView,
  McpFacetView,
  MemoryFacetView,
  QueryView,
  ReplayView,
  RetrievalFacetView,
  TimeTravelView,
  TraceDetailPanel,
  TraceExportModal,
} from "./_components/traces-hub-dynamics";

function TracesPageInner() {
  const hub = useTracesHub();

  if (hub.orgLoading && !hub.currentOrg && !hub.authError) {
    return (
      <div className="p-6" aria-busy="true" aria-label="Loading workspace">
        <LoadingSkeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!hub.currentOrg && !hub.authError) {
    return (
      <NoOrgState
        feature="Traces"
        syncing={hub.orgSyncing && !hub.orgSyncTimedOut}
        syncTimedOut={hub.orgSyncTimedOut}
        onRetrySync={() => void hub.refreshOrgs()}
        description={
          hub.orgSyncTimedOut
            ? undefined
            : hub.orgSyncing
              ? undefined
              : "Create a workspace to view traces. The product tour does not create or sync your workspace."
        }
      />
    );
  }
  if (!hub.currentOrg) return null;

  const toolbar = (
    <TracesToolbar
      hubView={hub.hubView}
      onHubViewChange={hub.selectHubView}
      filterMode={hub.filterMode}
      onFilterModeChange={hub.setFilterMode}
      filter={hub.filter}
      activeFacet={hub.activeFacet}
      onFiltersChange={(next) => {
        hub.applyListFilters({
          realm: next.realm,
          outcome: next.outcome,
          agent_id: next.agent_id,
        });
      }}
      query={hub.query}
      onQueryChange={(q) => {
        hub.setQuery(q);
        hub.setUrlState({ q });
        hub.writeFilterParams(hub.filter, q);
      }}
      onCreateAlert={() => hub.handleCreateAlertFromFilters(hub.filter)}
      views={hub.views}
      viewPresets={hub.viewPresets}
      savedViewId={hub.savedViewId}
      filterDirty={hub.filterDirty}
      onSelectView={hub.applyView}
      onSaveView={async (name, isShared) => {
        await hub.save({
          name,
          state: hub.currentViewState,
          is_shared: isShared,
        });
      }}
      onSaveChanges={
        hub.savedViewId
          ? async () => {
              await hub.update({
                viewId: hub.savedViewId!,
                state: hub.currentViewState,
              });
            }
          : undefined
      }
      onDiscardView={() => {
        if (hub.savedViewId) {
          hub.applyView(hub.savedViewId);
          return;
        }
        hub.applyView("");
      }}
      onDeleteView={async (id) => hub.remove(id)}
      liveOn={hub.liveOn}
      onLiveChange={hub.setLiveOn}
      refreshing={hub.refreshing}
      onRefresh={hub.refresh}
      visibleColumns={hub.visibleColumns}
      onVisibleColumnsChange={hub.writeVisibleColumns}
      pastHours={hub.pastHours}
      onPastHoursChange={hub.setPastHours}
    />
  );

  const detailPanel = hub.traceId ? (
    <DetailPanelShell
      open
      onClose={hub.handleCloseDetail}
      mobileDrawer={false}
      widthClassName="w-full min-w-0"
      title={(() => {
        const selected = hub.traces.find((t) => t.trace_id === hub.traceId);
        const primary =
          selected?.agent_id ||
          selected?.model ||
          `${hub.traceId.slice(0, 20)}…`;
        const showUuid = Boolean(selected?.agent_id || selected?.model);
        return (
          <span className="flex min-w-0 flex-col gap-space-1">
            <span className="truncate text-sm font-medium">{primary}</span>
            {showUuid ? (
              <span className="truncate font-mono text-2xs text-[var(--text-muted)]">
                {hub.traceId.slice(0, 20)}…
              </span>
            ) : null}
          </span>
        );
      })()}
    >
      <TraceDetailPanel
        traceId={hub.traceId}
        highlightSpanId={hub.spanId}
        onClose={hub.handleCloseDetail}
        hideCloseControl
        initialMode={hub.detailMode}
        onModeChange={hub.handleDetailModeChange}
        onSpanSelect={hub.handleSelectSpan}
      />
    </DetailPanelShell>
  ) : null;

  const hubTable =
    hub.isLegacyView || hub.isFacetView ? (
      <EmbeddedSurface>
        {hub.hubView === "inspect" && <InspectView />}
        {hub.hubView === "replay" && <ReplayView />}
        {hub.hubView === "debug" && <DebugView />}
        {hub.hubView === "query" && <QueryView />}
        {hub.hubView === "time-travel" && <TimeTravelView />}
        {hub.activeFacet === "mcp" && <McpFacetView />}
        {hub.activeFacet === "decisions" && <DecisionsFacetView />}
        {hub.activeFacet === "memory" && <MemoryFacetView />}
        {hub.activeFacet === "retrieval" && <RetrievalFacetView />}
      </EmbeddedSurface>
    ) : (
      <TracesHubList {...hub} />
    );

  return (
    <PageContent size="wide">
      <ResourcePageShell
        header={
          <PageHeader
            eyebrow="Observe"
            title="Traces"
            subtitle="Traces, spans, and sessions — shareable filters and inline transcript detail."
          />
        }
        toolbar={hub.isLegacyView ? undefined : toolbar}
        table={
          hub.isLegacyView || hub.isFacetView ? (
            hubTable
          ) : (
            <TraceSplitLayout
              panelMinPx={400}
              stackBelowPx={800}
              master={hubTable}
              detail={detailPanel}
            />
          )
        }
        detail={hub.isLegacyView || hub.isFacetView ? detailPanel : null}
      />

      <TraceExportModal
        open={hub.exportOpen}
        onOpenChange={hub.setExportOpen}
        orgId={hub.currentOrg.id}
        traceId={hub.exportTraceId}
      />
      <AnnotateTraceDialog
        open={hub.annotateOpen}
        onOpenChange={hub.setAnnotateOpen}
        traceId={hub.annotateTraceId}
      />
    </PageContent>
  );
}

export default function TracesPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="table" lines={6} size="wide" />}>
      <TracesPageInner />
    </Suspense>
  );
}
