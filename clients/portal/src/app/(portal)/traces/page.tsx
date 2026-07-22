"use client";

/**
 * /traces — U01 Traces Hub: Traces | Spans | Sessions with fullscreen modal detail.
 * Wave 3 shell ≤400 LOC — state in use-traces-hub, list in traces-hub-list.
 */

import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { ResourcePageShell } from "@/components/portal-os";
import { TraceViewerModal } from "@/components/traces/TraceViewerModal";
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
  if (!hub.currentOrg) {
    return (
      <ErrorState
        title="Could not load workspace"
        message={hub.authError ?? "Authentication required"}
        onRetry={() => void hub.refreshOrgs()}
      />
    );
  }

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

  const selectedTrace = hub.traceId
    ? hub.traces.find((t) => t.trace_id === hub.traceId)
    : undefined;
  const traceIndex = hub.traceId
    ? hub.traces.findIndex((t) => t.trace_id === hub.traceId)
    : -1;
  const modalTitle =
    selectedTrace?.agent_id ||
    selectedTrace?.model ||
    (hub.traceId ? `${hub.traceId.slice(0, 20)}…` : undefined);

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
            subtitle="Traces, spans, and sessions — shareable filters and fullscreen transcript detail."
          />
        }
        toolbar={hub.isLegacyView ? undefined : toolbar}
        table={hubTable}
      />

      {hub.traceId ? (
        <TraceViewerModal
          open
          onClose={hub.handleCloseDetail}
          traceId={hub.traceId}
          title={modalTitle}
          outcome={selectedTrace?.outcome ?? null}
          onPrev={
            traceIndex > 0
              ? () => hub.handleSelectTrace(hub.traces[traceIndex - 1]!.trace_id)
              : undefined
          }
          onNext={
            traceIndex >= 0 && traceIndex < hub.traces.length - 1
              ? () => hub.handleSelectTrace(hub.traces[traceIndex + 1]!.trace_id)
              : undefined
          }
        >
          <TraceDetailPanel
            traceId={hub.traceId}
            highlightSpanId={hub.spanId}
            onClose={hub.handleCloseDetail}
            hideCloseControl
            layout="fullscreen"
            initialMode={hub.detailMode}
            onModeChange={hub.handleDetailModeChange}
            onSpanSelect={hub.handleSelectSpan}
          />
        </TraceViewerModal>
      ) : null}

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
