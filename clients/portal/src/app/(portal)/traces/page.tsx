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

import { useCallback, useEffect, useMemo, useState , Suspense} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { TracesTab } from "../observability/_components/TracesTab";
import { AnnotateTraceDialog } from "../observability/_components/AnnotateTraceDialog";
import type { TraceFilter, TraceItem } from "../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { api, agentSessionsApi } from "@/lib/api";
import { SessionTimeline, type AgentSessionTimelineItem } from "@/components/observability/SessionTimeline";
import { TraceExportModal } from "../observability/_components/TraceExportModal";
import { TraceShareModal } from "../observability/_components/TraceShareModal";
import { LiveTailPanel } from "./_components/LiveTailPanel";
import { SpanSearchBar } from "./_components/SpanSearchBar";
import { RefreshCw } from "lucide-react";

function TracesPageInner() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTraceId = searchParams.get("trace_id") || undefined;

  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [sessions, setSessions] = useState<AgentSessionTimelineItem[]>([]);
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
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTraceId, setShareTraceId] = useState<string>("");

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
      const [data, sessionRes] = await Promise.all([
        api.listObservabilityTraces(currentOrg.id, {
          ...(filter.realm ? { realm: filter.realm } : {}),
          ...(filter.outcome ? { outcome: filter.outcome } : {}),
          ...(filter.agent_id ? { agent_id: filter.agent_id } : {}),
          limit: 50,
        }),
        agentSessionsApi.list(currentOrg.id, {
          ...(filter.agent_id ? { agent_id: filter.agent_id } : {}),
          limit: 50,
        }).catch(() => ({ data: { sessions: [], count: 0 } })),
      ]);
      setTraces(data.traces as TraceItem[]);
      setSessions(sessionRes.data?.sessions ?? []);
    } catch (e) {
      console.error("Traces load failed:", e);
      toast.error(e instanceof Error ? e.message : "Failed to load traces");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, filter, toast]);

  const sessionTimeline = useMemo(() => {
    const byId = new Map<string, AgentSessionTimelineItem>();
    for (const s of sessions) {
      byId.set(s.id, { ...s, trace_ids: [...(s.trace_ids ?? [])] });
    }
    for (const t of traces) {
      const sid = t.agent_session_id ?? t.session_id;
      if (!sid) continue;
      const existing = byId.get(sid);
      if (existing) {
        const ids = new Set(existing.trace_ids ?? []);
        ids.add(t.trace_id);
        existing.trace_ids = Array.from(ids);
        if (!existing.agent_id && t.agent_id) existing.agent_id = t.agent_id;
        if (!existing.started_at && t.started_at) existing.started_at = t.started_at;
      } else {
        byId.set(sid, {
          id: sid,
          agent_id: t.agent_id ?? null,
          trace_ids: [t.trace_id],
          started_at: t.started_at ?? undefined,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const ta = a.started_at ? Date.parse(a.started_at) : 0;
      const tb = b.started_at ? Date.parse(b.started_at) : 0;
      return tb - ta;
    });
  }, [sessions, traces]);

  useEffect(() => {
    if (currentOrg) loadTraces();
  }, [currentOrg, loadTraces]);

  if (!currentOrg) return <NoOrgState feature="Traces" />;

  return (
    <PageContent size="wide" className="space-y-6">
      <PageHeader
        eyebrow="Observe"
        title="Traces"
        subtitle="Search, filter, and inspect every trace in your system"
        icon={Layers}
        actions={
          <Button variant="outline" size="default" onClick={loadTraces} loading={loading} aria-label="Refresh traces">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4 min-w-0">
          <section aria-label="Agent sessions">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              Agent sessions
            </h2>
            <SessionTimeline
              sessions={sessionTimeline}
              orgId={currentOrg.id}
              className="mb-2"
            />
          </section>
          <SpanSearchBar orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
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
        <LiveTailPanel orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
      </div>
      <TraceExportModal
        open={exportOpen}
        onOpenChange={setExportOpen}
        orgId={currentOrg.id}
        traceId={exportTraceId}
      />
      <AnnotateTraceDialog
        open={annotateOpen}
        onOpenChange={setAnnotateOpen}
        traceId={annotateTraceId}
      />
      <TraceShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        traceId={shareTraceId}
      />
    </PageContent>
  );
}


// Wrap TracesPageInner in a Suspense boundary because it reads
// ``useSearchParams()``. Without the boundary Next.js cannot
// statically optimise the page and the RSC prefetch
// (``?._rsc=...``) returns a partial / erroring payload, which
// surfaces in the browser console as a 404.
export default function TracesPage() {
  return (
    <Suspense fallback={null}>
      <TracesPageInner />
    </Suspense>
  );
}
