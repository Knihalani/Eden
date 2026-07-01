"use client";

/**
 * /traces — Trace Explorer (real page, June 2026).
 *
 * Replaces the old redirect stub `router.replace("/observability#traces")`
 * with a first-class route that:
 *   • Has its own PageHeader
 *   • Uses the extracted TracesTab component
 *   • Honors `?trace_id=abc-123` deep links (pre-selects the row)
 *   • Has its own loading.tsx (LoadingSkeleton variant="table")
 *
 * The export action is wired through the same TraceExportModal that's
 * still used by the legacy /observability page. Once that page becomes
 * a thin landing, the export modal can be promoted to a shared
 * component and reused here.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { TracesTab } from "../observability/_components/TracesTab";
import { AnnotateTraceDialog } from "../observability/_components/AnnotateTraceDialog";
import type { TraceFilter, TraceItem } from "../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { TraceExportModal } from "../observability/_components/TraceExportModal";

export default function TracesPage() {
  const { currentOrg } = useOrg();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTraceId = searchParams.get("trace_id") || undefined;

  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TraceFilter>({ realm: "", outcome: "", agent_id: "" });
  const [_, setSelectedTraceId] = useState<string>(initialTraceId ?? "");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTraceId, setExportTraceId] = useState<string>("");
  // Pattern 5.2 (Langfuse): dialog state. Lives at the page level
  // so the dialog portals cleanly to body regardless of the table
  // re-rendering.
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotateTraceId, setAnnotateTraceId] = useState<string>("");

  const handleSelectTrace = useCallback(
    (id: string) => {
      setSelectedTraceId(id);
      // Open the observability landing page with the trace
      // right-rail active (Pattern 4.4). The landing reads
      // ?trace_id=… and renders <SelectedTraceRail>.
      router.push(`/observability?trace_id=${encodeURIComponent(id)}`);
    },
    [router],
  );

  const handleViewTimeline = useCallback(
    (id: string) => {
      setSelectedTraceId(id);
      router.push(`/replay?trace=${encodeURIComponent(id)}`);
    },
    [router],
  );

  const handleExport = useCallback((id: string) => {
    setExportTraceId(id);
    setExportOpen(true);
  }, []);

  const handleAnnotate = useCallback((id: string) => {
    setAnnotateTraceId(id);
    setAnnotateOpen(true);
  }, []);

  const loadTraces = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const data = await api.listObservabilityTraces(currentOrg.id, {
        ...(filter.realm ? { realm: filter.realm } : {}),
        ...(filter.outcome ? { outcome: filter.outcome } : {}),
        ...(filter.agent_id ? { agent_id: filter.agent_id } : {}),
        limit: 50 });
      setTraces(data.traces as TraceItem[]);
    } catch (e) {
      console.error("Traces load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, filter]);

  useEffect(() => {
    if (currentOrg) loadTraces();
  }, [currentOrg, loadTraces]);

  if (!currentOrg) return <NoOrgState feature="Trace Explorer" />;

  return (
    <>
      <PageHeader
        eyebrow="Observe"
        title="Trace Explorer"
        subtitle="Search, filter, and inspect every trace in your system"
        icon={Layers}
        actions={
          <button
            onClick={loadTraces}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] transition-colors"
          >
            <Layers className="w-4 h-4" />
            Refresh
          </button>
        }
      />
      <div className="page-enter px-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full">
        <TracesTab
          traces={traces}
          loading={loading}
          filter={filter}
          onFilterChange={setFilter}
          onSelectTrace={handleSelectTrace}
          onViewTimeline={handleViewTimeline}
          onExport={handleExport}
          onAnnotate={handleAnnotate}
          initialTraceId={initialTraceId}
        />
      </div>
      <TraceExportModal
        open={exportOpen}
        onOpenChange={setExportOpen}
        orgId={currentOrg.id}
        traceId={exportTraceId}
      />
      {/* Pattern 5.2 (Langfuse) — annotate dialog. No-op endpoint
          for now; see api.annotateTrace in src/lib/api.ts. */}
      <AnnotateTraceDialog
        open={annotateOpen}
        onOpenChange={setAnnotateOpen}
        traceId={annotateTraceId}
      />
    </>
  );
}
